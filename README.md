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

**Foydalanuvchilar** bo'limi (admin va ega): ism, email yoki jamoa nomi bo'yicha qidiruv, rol bo'yicha filtr, keraksiz foydalanuvchini o'chirish. Admin faqat oddiy foydalanuvchini o'chiradi, adminni faqat ega o'chiradi; tasdiqlangan jamoasi bor foydalanuvchini o'chirishdan oldin jamoa o'chiriladi, kutilayotgan arizasi esa avtomatik bekor bo'ladi.

Parol unutilsa: ega "Foydalanuvchi ma'lumotlari"dagi **Parol** tugmasi bilan yangi parol o'rnatadi (foydalanuvchining eski sessiyalari yopiladi).

## Jarayon

- **Jamoa:** bir foydalanuvchi faqat **bitta** jamoa ochadi (4–8 a'zo, birinchi kishi sardor). Holati "Jamoalar → Mening jamoam"da ko'rinadi.
  - Tasdiq kutilayotgan arizani **qaytarib olish** mumkin.
  - Tasdiqlangan jamoaning **faoliyatini tugatish** mumkin. Jamoa e'lon qilingan turda qatnashgan bo'lsa, u "faoliyati tugatilgan" bo'lib arxivlanadi: natijalari va reytingdagi qatori saqlanadi, yangi turlarga qo'shilmaydi. Qatnashmagan bo'lsa, butunlay o'chadi. Shundan keyin foydalanuvchi yangi jamoa ocha oladi.
  - Admin jamoani o'chirganda ham shu qoida ishlaydi.
- O'xshash nomlar (raqam qo'shish, `x/h` farqi, mayda imlo farqi) serverda bloklanadi.
- Admin tasdiqlagan jamoalar turga qo'shiladi, javoblar `+/−` bilan kiritiladi. E'lon qilinmagan tur javoblari faqat admin/egaga ko'rinadi.

## Hisoblash

- **Savol reytingi (SR):** `turda qatnashgan jamoalar − savolni topgan jamoalar + 1`. Kam jamoa topgan savol qimmatroq.
- Jamoaning SR'i — u topgan savollar reytinglarining yig'indisi.
- Turdagi o'rin: **to'g'ri javoblar soni** → teng bo'lsa **SR**. Ikkalasi ham teng bo'lsa jamoalar o'rinni **bo'lishadi** va bir xil ball oladi.
- **Tur balli:** `qatnashgan jamoalar − o'rin + 1`.
- **Mavsum reytingi:** tur ballari yig'indisi → teng bo'lsa jami to'g'ri javoblar → jami SR.

## Apellyatsiya

- Ega "Huquq va sozlamalar"da yoqadi. Faqat jamoa sardori, jamoasi qatnashgan va hali e'lon qilinmagan tur bo'yicha, **yozma** ravishda yuboradi.
- Matn uzunligi **so'z chegarasi** bilan cheklanadi (standart 100). Chegarani admin va ega "Apellyatsiyalar" bo'limida o'zgartiradi.
- Holatlar: **Yuborildi → Ko'rib chiqilmoqda → Ko'rib chiqildi**. Admin javob yozadi; "Ko'rib chiqildi" uchun javob majburiy. Foydalanuvchi holat va javobni "Apellyatsiya" sahifasida ko'radi.
- Bir savol bo'yicha ochiq apellyatsiya bo'lsa, ikkinchisini yuborib bo'lmaydi.

## Monitoring (faqat ega)

"Boshqaruv → Monitoring": server holati, xotira/protsessor/so'rovlar grafigi (1 soat – 30 kun), xatolar va sekin so'rovlar, ishga tushish/to'xtash/kutilmagan yiqilishlar, baza hajmi va jadvallari, faollik (kirishlar, xato parollar, jamoa va apellyatsiya holatlari), so'nggi harakatlar va **Railway xarajat taxmini**. Ma'lumot har daqiqada yig'iladi va 30 kun saqlanadi. Xarajat taxminiga Postgres servisining o'z xotira/protsessor sarfi kirmaydi — aniq summa Railway → Usage'da.

## Xavfsizlik

- Parollar `scrypt` bilan xeshlanadi, ochiq holda saqlanmaydi. Kirish/ro'yxatdan o'tishga urinishlar soni cheklangan.
- `SESSION_SECRET` va `OWNER_PASSWORD`ni hech kimga bermang, `.env` faylini repoga qo'shmang.
- Admin amallari `audit_log` jadvalida qayd etiladi.

---
G'oya muallifi va platforma yaratuvchisi: **Adhamjon Zokirjanov**
