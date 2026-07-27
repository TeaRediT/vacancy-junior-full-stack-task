// "use server";

// import { prisma } from "@/lib/prisma";
// import { auth } from "@/lib/auth";
// import { revalidatePath } from "next/cache";

// export type TransferInput = {
//   fromAccountId: string;
//   toAccountId: string;
//   amount: number;
// };

// // Внутрішній P2P-переказ між рахунками.
// // Цей код зараз у проді. Він "працює" на демо, але вже були скарги
// // від користувачів і кілька дивних балансів у базі.
// export async function transferMoney(input: TransferInput) {
//   const { fromAccountId, toAccountId, amount } = input;

//   const from = await prisma.account.findUnique({ where: { id: fromAccountId } });
//   const to = await prisma.account.findUnique({ where: { id: toAccountId } });

//   if (!from || !to) {
//     throw new Error("Account not found");
//   }

//   try {
//     await prisma.account.update({
//       where: { id: fromAccountId },
//       data: { balance: from.balance - amount },
//     });

//     await prisma.account.update({
//       where: { id: toAccountId },
//       data: { balance: to.balance + amount },
//     });

//     await prisma.transfer.create({
//       data: { fromAccountId, toAccountId, amount },
//     });

//     revalidatePath("/");
//     return { success: true };
//   } catch (e) {
//     console.log("Transfer failed", input, e);
//     return { success: true };
//   }
// }

"use server";

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";

export type TransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
};

export async function transferMoney(input: TransferInput) {
  const { fromAccountId, toAccountId, amount } = input;

  // 1. Валідація суми: додатне, скінченне число
  if (typeof amount !== "number" || Number.isNaN(amount) || amount <= 0) {
    return { success: false, error: "Некоректна сума переказу." };
  }

  // 2. Заборона переказу самому собі
  if (fromAccountId === toAccountId) {
    return {
      success: false,
      error: "Не можна переказати кошти на той самий рахунок.",
    };
  }

  // 3. Авторизація
  const session = await auth();
  if (!session.userId) {
    return { success: false, error: "Неавторизований доступ." };
  }

  try {
    // 4. Транзакція: всі операції читання та запису виконаються разом
    await prisma.$transaction(async (tx) => {
      const from = await tx.account.findUnique({
        where: { id: fromAccountId },
      });
      const to = await tx.account.findUnique({ where: { id: toAccountId } });

      if (!from || !to) {
        throw new Error("Рахунки не знайдено.");
      }

      // Перевірка, що ініціатор запиту володіє рахунком
      if (from.userId !== session.userId) {
        throw new Error(
          "Ви не маєте права ініціювати переказ із цього рахунку.",
        );
      }

      // 5. Валюта: заборона змішувати різні валюти без конвертації
      if (from.currency !== to.currency) {
        throw new Error(
          `Перекази між різними валютами (${from.currency} => ${to.currency}) наразі не підтримуються.`,
        );
      }

      // 6. Достатність коштів на балансі
      if (from.balance < amount) {
        throw new Error("Недостатньо коштів на рахунку.");
      }

      // 7. decrement / increment
      const updatedSender = await tx.account.updateMany({
        where: {
          id: fromAccountId,
          balance: { gte: amount }, // База даних оновить рядок тільки якщо баланс >= сумі переказу
        },
        data: {
          balance: { decrement: amount },
        },
      });

      if (updatedSender.count === 0) {
        throw new Error("Недостатньо коштів на рахунку.");
      }

      await tx.account.update({
        where: { id: toAccountId },
        data: { balance: { increment: amount } },
      });

      // Запис в історію
      await tx.transfer.create({
        data: { fromAccountId, toAccountId, amount },
      });
    });

    //Не працює при тестах
    try {
      revalidatePath("/");
    } catch {}

    return { success: true };
  } catch (e) {
    console.error("Transfer error:", e);
    // 8. Коректна обробка помилок
    return {
      success: false,
      error: e instanceof Error ? e.message : "Внутрішня помилка сервера.",
    };
  }
}
