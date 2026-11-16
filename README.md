# COLBA Zakovat ligasi — Railway + PostgreSQL

Zakovat ligasi sayti: jamoalarni ro'yxatga olish, turlarda javoblarni kiritish, natija va reyting, apellyatsiya. Ma'lumotlar Railway PostgreSQL bazasida saqlanadi. Saytga email va parol bilan kiriladi.

- `server.js` — Express API (sessiyalar, rollar, hisob-kitob ma'lumotlari)
- `public/index.html` — sayt interfeysi

## Railway'ga joylash

1. Repo'ni Railway servisiga ulang.
2. Loyihaga **PostgreSQL** qo'shing (+ Create → Database → PostgreSQL).
3. Sayt servisining **Variables** bo'limiga kiriting:

| O'zgaruvchi | Qiymat |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `OWNER_EMAIL` | sayt egasining emaili |
| `OWNER_PASSWORD` | sayt egasining paroli (kamida 8 belgi) |
| `SESSION_SECRET` | 32+ belgili tasodifiy maxfiy kalit |
| `NODE_ENV` | `production` |
| `PGSSL` | `false` (Railway ichki Postgres uchun) |

4. Deploy qiling. Sayt egasi `OWNER_EMAIL` / `OWNER_PASSWORD` bilan "Kirish" orqali kiradi.

Biror o'zgaruvchi yetishmasa, server ishga tushmaydi va Deploy Logs'da sababini aniq yozadi.

## Rollar

- **Sayt egasi** — Railway'dagi `OWNER_EMAIL`/`OWNER_PASSWORD`. Ularni o'zgartirsangiz, keyingi deploy'da yangi qiymatlar kuchga kiradi, eski ega oddiy foydalanuvchiga aylanadi. Asosiy sahifa, yangiliklar, turlar soni, apellyatsiya oynasi, jamoa nomini tahrirlash, natijani qayta ochish, adminlarni tayinlash, parolni tiklash.
- **Administrator** — ega "Boshqaruv → Foydalanuvchi ma'lumotlari"da tayinlaydi. Jamoalarni tasdiqlash/rad etish, tur ishtirokchilari, javoblarni kiritish, natijalarni e'lon qilish, apellyatsiyalarni ko'rib chiqish.
- **Foydalanuvchi** — saytda "Ro'yxatdan o'tish" orqali (ism, email, parol). Sahifalarni ko'radi, jamoa arizasini yuboradi, o'z jamoasi bo'yicha apellyatsiya beradi.

Parol unutilsa: ega "Foydalanuvchi ma'lumotlari"dagi **Parol** tugmasi bilan yangi parol o'rnatadi (foydalanuvchining eski sessiyalari yopiladi).

## Jarayon

- **Jamoa arizasi:** 4–8 a'zo, birinchi kishi sardor. Bir foydalanuvchida bir vaqtda bitta kutilayotgan ariza. Holati "Mening arizalarim"da ko'rinadi.
- O'xshash nomlar (raqam qo'shish, `x/h` farqi, mayda imlo farqi) serverda bloklanadi.
- Admin tasdiqlagan jamoalar turga qo'shiladi, javoblar `+/−` bilan kiritiladi. E'lon qilinmagan tur javoblari faqat admin/egaga ko'rinadi.
- Turdagi tartib: **to'g'ri javoblar soni** → **SR** (savol reytingi = qatnashgan jamoalar − shu savolni topganlar + 1) → nom. Tur balli: `jamoalar soni − o'rin + 1`.
- **Apellyatsiya:** ega yoqqanda ochiladi. Faqat jamoani ro'yxatdan o'tkazgan sardor, jamoa qatnashgan va hali e'lon qilinmagan tur bo'yicha yuboradi.

## Xavfsizlik

- Parollar `scrypt` bilan xeshlanadi, ochiq holda saqlanmaydi. Kirish/ro'yxatdan o'tishga urinishlar soni cheklangan.
- `SESSION_SECRET` va `OWNER_PASSWORD`ni hech kimga bermang, `.env` faylini repoga qo'shmang.
- Admin amallari `audit_log` jadvalida qayd etiladi.
