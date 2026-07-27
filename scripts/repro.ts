import { PrismaClient } from "@prisma/client";
import { transferMoney } from "../src/app/actions/transfer";

const prisma = new PrismaClient();

// Скрипт відтворення бага.
//
// Мета: показати проблему ДО виправлення, а після фіксу — довести, що її більше
// немає. Нижче один приклад-заготовка (списання в мінус). Додай свої сценарії
// для інших знайдених багів.

async function reset() {
  await prisma.transfer.deleteMany();
  await prisma.account.deleteMany();
  await prisma.account.createMany({
    data: [
      {
        id: "acc-alice",
        userId: "user-1",
        ownerName: "Alice",
        balance: 1000,
        currency: "USD",
      },
      {
        id: "acc-bob",
        userId: "user-2",
        ownerName: "Bob",
        balance: 500,
        currency: "USD",
      },
      {
        id: "acc-carol",
        userId: "user-3",
        ownerName: "Carol",
        balance: 0,
        currency: "EUR",
      },
    ],
  });
}

async function balances() {
  const accs = await prisma.account.findMany({ orderBy: { ownerName: "asc" } });
  return Object.fromEntries(accs.map((a) => [a.ownerName, a.balance]));
}

// Допоміжна функція для ізольованого запуску кожного сценарію
async function runScenario(name: string, testFn: () => Promise<void>) {
  console.log(`\n========================================`);
  console.log(`СЦЕНАРІЙ: ${name}`);
  console.log(`========================================`);

  await reset();
  console.log("Баланси ДО:", await balances());

  await testFn();

  console.log("Баланси ПІСЛЯ:", await balances());
}

async function main() {
  // await reset();
  // console.log("Баланси до:", await balances());
  // // Приклад бага: переказуємо більше, ніж є на рахунку.
  // // Очікувано: система має відхилити переказ. Фактично — баланс іде в мінус.
  // await transferMoney({
  //   fromAccountId: "acc-bob",
  //   toAccountId: "acc-alice",
  //   amount: 999999,
  // });
  // console.log("Баланси після:", await balances());
  // console.log(
  //   "Якщо у Bob від'ємний баланс — баг відтворено. Після фіксу переказ має впасти з помилкою.",
  // );

  console.log("Запуск тестів. Поточна сесія: user-1 (Alice)\n");

  await runScenario("1. Списання в мінус", async () => {
    // Після фіксу: помилка "Недостатньо коштів".
    // До фіксу: баланс Alice стає від'ємним.
    const res = await transferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: 999999, // Більше, ніж є
    });
    console.log("Результат виклику:", res);
  });

  await runScenario("2. Від'ємна сума", async () => {
    // Після фіксу: помилка валідації.
    // До фіксу: Alice "відправила" -500. У неї стало 1500, у Bob 0.
    const res = await transferMoney({
      fromAccountId: "acc-alice",
      toAccountId: "acc-bob",
      amount: -500,
    });
    console.log("Результат виклику:", res);
  });

  await runScenario("3. Змішування валют", async () => {
    // Очікувано після фіксу: помилка через різні валюти.
    // Фактично до фіксу: 100 USD просто додавалися як 100 EUR до рахунку Bob.
    const res = await transferMoney({
      fromAccountId: "acc-alice", // USD
      toAccountId: "acc-carol", // EUR
      amount: 100,
    });
    console.log("Результат виклику:", res);
  });

  await runScenario("4. Крадіжка з чужого рахунку", async () => {
    // Залогінена Alice (user-1). Вона намагається ініціювати переказ з рахунку Bob на свій.
    // Очікувано після фіксу: помилка доступу.
    // Фактично до фіксу: гроші списувались у Bob і йшли Alice.
    const res = await transferMoney({
      fromAccountId: "acc-bob",
      toAccountId: "acc-alice",
      amount: 100,
    });
    console.log("Результат виклику:", res);
  });

  await runScenario("5. Стан гонитви", async () => {
    // У Alice 1000 USD. Відправляємо 10 запитів по 200 USD одночасно.
    // Очікувано після фіксу: 5 пройдуть (баланс стане 0), 5 відхиляться.
    // Фактично до фіксу: всі 10 можуть пройти, баланс пробиває нуль і йде в -1000.
    console.log("Відправляємо 10 паралельних запитів по 200 USD...");
    const promises = Array.from({ length: 10 }).map(() =>
      transferMoney({
        fromAccountId: "acc-alice",
        toAccountId: "acc-bob",
        amount: 200,
      }),
    );

    const results = await Promise.all(promises);
    const successCount = results.filter((r) => r.success).length;
    console.log(`Успішних запитів: ${successCount} із 10`);
  });

  const history = await prisma.transfer.findMany({
    orderBy: { createdAt: "desc" },
  });
  console.log("Історія переказів:", history);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
