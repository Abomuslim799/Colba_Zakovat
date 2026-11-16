# COLBA Zakovat ligasi — Railway + PostgreSQL + Google kirish

Bu loyiha avvalgi `colba_zakovat.html` prototipiga asoslanadi. Endi o'zgarishlar brauzer `localStorage`ida emas, **Railway PostgreSQL** bazasida saqlanadi. Har kim birinchi tashrifida Google orqali kirish oynasini ko'radi.

## Railway'ga joylash

1. Repo Railway servisiga ulanadi. `public/index.html` — saytning old qismi, `server.js` — Express API.
2. Railway'da **Postgres** ma'lumotlar bazasini qo'shing.
3. Sayt servisi `Variables` bo'limiga quyidagilarni kiriting:
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}` — Railway'dagi Postgres xizmatidan Reference Variable sifatida
   - `GOOGLE_CLIENT_ID=...apps.googleusercontent.com`
   - `OWNER_EMAIL=...` — sayt egasining **Google email manzili**
   - `SESSION_SECRET=...` — uzun, tasodifiy va maxfiy kalit (32+ belgi)
   - `NODE_ENV=production`
   - `PGSSL=false` (Railway ichki Postgres ulanishi uchun; tashqi server TLS talab qilsa `true`)
4. Google Cloud Console -> APIs & Services -> Credentials -> Create OAuth client ID -> **Web application**. `Authorized JavaScript origins` qismiga `https://SIZNING-DOMENINGIZ.up.railway.app` kiriting. Google Identity Services ID-token usulida ishlaydi; API client secret kerak emas.
5. Deploy qiling, saytni ochib belgilangan `OWNER_EMAIL` bilan Google orqali kiring. Ushbu hisobga avtomatik `owner` roli beriladi. Boshqa hisoblar `user` bo'ladi.
6. Sayt egasi **Boshqaruv → Foydalanuvchi ma'lumotlari** bo'limidan administratorlarni tayinlaydi.

## Jarayon

- Har bir foydalanuvchi Google hisob orqali kiradi va ma'lumotlari `app_users` jadvalida saqlanadi.
- **Jamoalar → Ro'yxatdan o'tish:** 4–8 a'zo, birinchi kishi sardor. Jamoa `pending` bo'lib saqlanadi. Bir foydalanuvchida bir vaqtda faqat bitta kutilayotgan ariza bo'ladi; o'z arizasining holatini "Mening arizalarim"da ko'radi.
- Jamoa nomi serverda tekshiriladi, raqam qo'shish, yozilishdagi `x/h` farqi yoki mayda imlo farqi bilan o'xshash nomlar bloklanadi. Kiritish vaqtida ham tekshiruv ishlaydi.
- **Boshqaruv → Jamoalar:** tasdiqlanmagan jamoalar faqat `Jamoa nomi (N a'zo)` ko'rinishidagi select ro'yxatida bo'ladi, administrator tanlab tasdiqlaydi yoki rad etadi.
- Tasdiqlangan jamoalar **Tur jamoalari**da tanlanadi; javoblar faqat administrator/egaga ko'rinadi.
- `+/-` javoblar serverda saqlanadi va ommaviy API tomonidan berilmaydi; tur yakunlanmaguncha umumiy reytingga kirmaydi.
- Turdagi tartib: **Jami to'g'ri javoblar** -> **SR (R=N+1 bo'yicha)** -> ism bo'yicha barqaror tartib. Tur reyting balli: `jamoalar soni - o'rin + 1`.
- Egasi apellyatsiya ko'rinishini yoqadi/o'chiradi, Asosiy sahifa va yangiliklarni boshqaradi, turlar sonini o'zgartiradi.
- **Foydalanuvchi ma'lumotlari** faqat owner uchun `/api/users` dan olinadi. Shaxsiy elektron pochta manzillari oddiy foydalanuvchilarga uzatilmaydi.

## Apellyatsiya

- Faqat tasdiqlangan jamoani ro'yxatdan o'tkazgan foydalanuvchi (sardor) yuboradi, faqat jamoa qatnashgan va hali e'lon qilinmagan tur bo'yicha.

## Muhim

- Eski prototipda faqat bir brauzer `localStorage`ida saqlangan ma'lumotlar **avtomatik ko'chirilmaydi**. Agar u yerda haqiqiy jamoalar va natijalar mavjud bo'lsa, ma'lumotlarni ko'chirish jarayonini alohida bajarish kerak.
- `OWNER_EMAIL` to'g'ri ko'rsatilishi kerak; aks holda hech kim sayt egasi bo'la olmaydi. Uni o'zgartirsangiz, keyingi ishga tushishda eski ega oddiy foydalanuvchiga aylanadi.
- `DATABASE_URL` yoki (production'da) 32+ belgili `SESSION_SECRET` bo'lmasa, server ishga tushmaydi va Railway loglarida aniq sababini yozadi.
- Bitta PostgreSQL `app_state` qatori yordamida jamoalar, turlar va javoblar serverda bir tranzaksiya ichida saqlanadi. Google kirish foydalanuvchilari alohida `app_users` jadvalida saqlanadi; admin amallarining qaydi `audit_log` jadvalida yuritiladi.
- `SESSION_SECRET` ni hech kim bilan ulashmang. Railway'ga deploy qilishdan oldin `.env` faylini ommaga joylamang.
- Barcha domenlar uchun HTTPS ishlating.
