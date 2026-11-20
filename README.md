# COLBA Zakovat ligasi — Railway + SQLite (servis diski)

Zakovat ligasi sayti: jamoalarni ro'yxatga olish, turlarda javoblarni kiritish, natija va reyting, apellyatsiya. Ma'lumotlar sayt servisining diskida (Railway Volume, `/data/colba.db`) bitta SQLite faylda saqlanadi — alohida baza servisi kerak emas. Saytga email va parol bilan kiriladi.

- `server.js` — Express API (sessiyalar, rollar, hisob-kitob ma'lumotlari)
- `db.js` — SQLite baza, sessiyalar ombori, eski Postgres'dan bir martalik ko'chirish
- `public/index.html` — sayt interfeysi

## Railway'ga joylash

1. Repo'ni Railway servisiga ulang.
2. Servisga **Volume** qo'shing: servis ustida o'ng tugma → *Attach Volume*, **Mount path: `/data`**. Volume'siz server ishga tushmaydi (aks holda har deploy'da ma'lumot o'chib ketardi).
3. Sayt servisining **Variables** bo'limiga kiriting:

| O'zgaruvchi | Qiymat |
|---|---|
| `OWNER_EMAIL` | sayt egasining emaili |
| `OWNER_PASSWORD` | sayt egasining paroli (kamida 8 belgi) |
| `SESSION_SECRET` | 32+ belgili tasodifiy maxfiy kalit |
| `NODE_ENV` | `production` |

4. Deploy qiling. Sayt egasi `OWNER_EMAIL` / `OWNER_PASSWORD` bilan "Kirish" orqali kiradi.

Biror o'zgaruvchi yoki Volume yetishmasa, server ishga tushmaydi va Deploy Logs'da sababini aniq yozadi.

### Postgres'dan ko'chish (bir martalik)

Volume'dagi baza hali bo'sh bo'lsa va `DATABASE_URL` berilgan bo'lsa, server birinchi ishga tushishda eski Postgres'dagi hamma narsani (liga holati, foydalanuvchilar va parollar, suratlar, jurnal, faol sessiyalar, 30 kunlik monitoring) diskdagi faylga ko'chiradi. Deploy Logs'da `Ko‘chirildi: …` qatori chiqadi. Saytni tekshirgach `DATABASE_URL` o'zgaruvchisini o'chiring va Postgres servisini olib tashlang. Keyingi ishga tushishlarda Postgres'ga umuman murojaat qilinmaydi.

### Zaxira nusxa

Disk bitta joyda turadi. "Boshqaruv → Monitoring → ⇩ Zaxira nusxa" butun bazani bitta `.db` fayl qilib yuklab beradi (faqat sayt egasi). Muhim o'zgarishlardan oldin va vaqti-vaqti bilan yuklab olib turing.

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
- Ro'yxatdan o'tishda **jamoa filiali** ham kiritiladi; filial jamoa kartalarida ko'rinadi.
- **Jadvaldan import** (admin/ega, "Boshqaruv → Jamoalar → ⇪ Jadvaldan import"): Google Form javoblari jadvalini sarlavha bilan nusxalab qo'yiladi → "Ko'rib chiqish" → import. Lider sardor qilib birinchi qo'yiladi, a'zolar ro'yxatidagi takrori olib tashlanadi, raqamlash va turkcha harflar (ş, ç, ğ, ö → sh, ch, g‘, o‘) tuzatiladi. Mavjud yoki o'xshash nomli jamoalar o'tkazib yuboriladi, shuning uchun bir jadvalni qayta import qilish xavfsiz. Import qilingan jamoalar tasdiqlangan bo'ladi.
- **Sardor hisobi:** import qilingan jamoaning sayt hisobi yo'q. Sardor saytda ro'yxatdan o'tgach, admin jamoa kartasida uni "Sardor hisobi" ro'yxatidan biriktiradi — shundan keyin u apellyatsiya bera oladi va "Mening jamoam"ni ko'radi.
- O'xshash nomlar (raqam qo'shish, `x/h` farqi, mayda imlo farqi) serverda bloklanadi.
- Admin tasdiqlagan jamoalar turga qo'shiladi, javoblar `+/−` bilan kiritiladi. E'lon qilinmagan tur javoblari faqat admin/egaga ko'rinadi.

## Hisoblash

- **Savol reytingi (SR):** `turda qatnashgan jamoalar − savolni topgan jamoalar + 1`. Kam jamoa topgan savol qimmatroq.
- Jamoaning SR'i — u topgan savollar reytinglarining yig'indisi.
- Turdagi o'rin: **to'g'ri javoblar soni** → teng bo'lsa **SR**. Ikkalasi ham teng bo'lsa jamoalar o'rinni **bo'lishadi** va bir xil ball oladi.
- **Tur balli:** `qatnashgan jamoalar − o'rin + 1`.
- **Mavsum reytingi:** tur ballari yig'indisi → teng bo'lsa jami to'g'ri javoblar → jami SR.

## Apellyatsiya

- Ega "Huquq va sozlamalar"da yoqadi. Jamoa sardori o'z jamoasi **qatnashgan istalgan tur** bo'yicha (natija e'lon qilingan bo'lsa ham) **yozma** e'tiroz yuboradi. Savol tanlanganda jadvaldagi joriy javob (+/−) ko'rinadi.
- Matn uzunligi **so'z chegarasi** bilan cheklanadi (standart 100). Chegarani admin va ega "Apellyatsiyalar" bo'limida o'zgartiradi.
- Holatlar: **Yuborildi → Ko'rib chiqilmoqda → Ko'rib chiqildi**. Admin javob yozadi; "Ko'rib chiqildi" uchun javob majburiy.
- Apellyatsiya qabul qilinsa, admin kartadagi tugma bilan shu savol javobini almashtiradi — natija e'lon qilingan bo'lsa ham; o'rin va reyting darhol qayta hisoblanadi, o'zgarish kim va qachon qilgani bilan saqlanadi.
- Bir savol bo'yicha ochiq apellyatsiya bo'lsa, ikkinchisini yuborib bo'lmaydi.

## Yordam

- Har bir foydalanuvchi "Yordam" bo'limida muammo yozadi: turda qatnashgani belgilanmagan, natijada xato, jamoa, saytdagi texnik xato yoki boshqa. Turni ham ko'rsatish mumkin.
- Admin va ega "Boshqaruv → Yordam"da ko'radi (yangilari soni menyuda), javob yozadi; holatlar apellyatsiyadagidek. Bir foydalanuvchida bir vaqtda 5 tagacha ochiq murojaat.

## Jamoa profili va medallar

- Har bir jamoaning profili bor (`#/jamoa/<id>`): mavsumdagi o'rni, ball, o'ynagan turlari, to'g'ri javoblar, eng yaxshi natija, faollik grafigi, turlar bo'yicha jadval, tarkib.
- **Tavsif va suratlar** (8 tagacha, har biri 700 KB gacha; brauzer yuklashdan oldin siqadi) — jamoa sardori yoki admin/ega qo'shadi. Suratlar bazada (servis diski) saqlanadi va faqat tizimga kirganlarga ko'rinadi.
- **Jamoani o'zgartirish arizasi** — tasdiqlangan jamoaning sardori profilda “Nom va tarkibni o'zgartirish” orqali yangi nom va 4–8 a'zoni yuboradi. Admin/ega tasdiqlaguncha jamoa avvalgi holatida qoladi; tasdiqlansa nom va tarkib birdaniga yangilanadi (eski holat `history` da saqlanadi), rad etilsa sabab sardorga ko'rinadi. Sardor arizani tahrirlashi yoki qaytarib olishi mumkin.
- **Randomayzer** (Boshqaruv → Randomayzer, admin/ega) — belgilangan jamoalardan bittasini tasodifiy tanlaydi. Tanlov serverda `crypto.randomInt` bilan bajariladi, oxirgi 100 tasi (maqsad, ro'yxat, natija, kim) tarixda saqlanadi va oddiy foydalanuvchilarga ko'rinmaydi. Tez tanlash: hammasi / tur jamoalari; “Uni chiqarib, yana tanlash” navbat aniqlash uchun; proyektor uchun to'liq ekran.
- **Medallar** — e'lon qilingan har bir turda: 1-o'rin — **Olmos** (oltin gerb), 2-o'rin — **Yoqut** (kumush), 3-o'rin — **Zumrad** (bronza); o'rin teng bo'lsa ikkala jamoaga. Savolni turda faqat bitta jamoa topsa — **Aleksandrit** (gerbsiz tosh, og'dirilganda yashildan qizil-binafshaga o'tadi). Boshqa savollarga medal yo'q. Medal ustida yozuv yo'q: bosilsa kattalashadi, orqasida qaysi tur va o'rin/savol uchun berilgani; har bir medalning ma'nosi profil va Savollar xaritasi sahifasida yozilgan.
- **Savollar xaritasi** (`#/savollar`): har bir tur uchun hamma topgan, hech kim topmagan va kam topilgan savollar, kim topgani va qanday medal olgani.
- Bosh sahifada reyting oynasi: oxirgi turdagi o'rin o'zgarishi (▲▼) va eng ko'p o'sgan jamoalar.

## Navigatsiya

- Har bir sahifaning o'z manzili bor, brauzerning "orqaga" tugmasi ishlaydi, havolani ulashish mumkin.
- Telefon va planshetda pastki menyu; ikki marta bosilganda sahifa kattalashmaydi.
- Sahifa gzip bilan siqib beriladi, logotip alohida keshlanadi.

## Monitoring (faqat ega)

"Boshqaruv → Monitoring": server holati, xotira/protsessor/so'rovlar grafigi (1 soat – 30 kun), xatolar va sekin so'rovlar, ishga tushish/to'xtash/kutilmagan yiqilishlar, baza hajmi va jadvallari, faollik (kirishlar, xato parollar, jamoa va apellyatsiya holatlari), so'nggi harakatlar va **Railway xarajat taxmini**. Ma'lumot har daqiqada yig'iladi va 30 kun saqlanadi. Baza shu servisning diskida bo'lgani uchun alohida baza servisi xarajati yo'q; aniq summa Railway → Usage'da.

## Xavfsizlik

- Parollar `scrypt` bilan xeshlanadi, ochiq holda saqlanmaydi. Kirish/ro'yxatdan o'tishga urinishlar soni cheklangan.
- `SESSION_SECRET` va `OWNER_PASSWORD`ni hech kimga bermang, `.env` faylini repoga qo'shmang.
- Admin amallari `audit_log` jadvalida qayd etiladi.

---
G'oya muallifi va platforma yaratuvchisi: **Adhamjon Zokirjanov**
