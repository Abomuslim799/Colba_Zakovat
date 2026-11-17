'use strict';
// Jadvaldan (Google Form / Google Sheets) jamoalarni import qilish uchun tozalash qoidalari.

// Turk klaviaturasida yozilgan harflarni o'zbek lotin yozuviga keltirish
const LETTERS = [
  [/Ş/g, 'Sh'], [/ş/g, 'sh'], [/Ç/g, 'Ch'], [/ç/g, 'ch'], [/Ğ/g, 'G‘'], [/ğ/g, 'g‘'],
  [/Ö/g, 'O‘'], [/ö/g, 'o‘'], [/Ü/g, 'U'], [/ü/g, 'u'], [/İ/g, 'I'], [/ı/g, 'i'],
];
function fixLetters(s) {
  let out = String(s || '').normalize('NFC');
  for (const [re, to] of LETTERS) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}
const cleanName = (s) => fixLetters(s).replace(/^["'«“”„‘’`]+|["'»“”„‘’`]+$/g, '').trim();
const cleanPerson = (s) => fixLetters(s).replace(/^\s*\d+\s*[.)\-:]?\s*/, '').replace(/[,;.]+$/, '').trim();

// "Valiyev Ali" va "Valiyev Ali Karim o‘g‘li" — bitta odam (biri ikkinchisining qismi)
const tokens = (s) => s.toLocaleLowerCase('uz').replace(/[’‘ʻ`']/g, '').split(/\s+/).filter(Boolean);
function samePerson(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  return small.every((t) => big.includes(t));
}

/**
 * row: { name, leader, members (matn: qatorlar yoki ";" bilan), branch }
 * Natija: { name, members: [sardor, ...], branch, notes: [], error }
 */
function cleanRow(row) {
  const notes = [];
  const name = cleanName(row.name).slice(0, 80);
  if (name !== String(row.name || '').trim()) notes.push('nom tozalandi');
  const branch = fixLetters(row.branch).slice(0, 60);
  let leader = cleanPerson(row.leader).slice(0, 100);
  const members = String(row.members || '')
    .split(/\r?\n|;/)
    .map(cleanPerson)
    .filter((x) => x.length > 0)
    .map((x) => x.slice(0, 100));
  if (leader) {
    const i = members.findIndex((m) => samePerson(m, leader));
    if (i >= 0) {
      // Bitta odam: to'liqroq yozilgan ism qoladi
      if (members[i].length > leader.length) leader = members[i];
      members.splice(i, 1);
    } else {
      notes.push('lider a’zolar ro‘yxatida yo‘q edi — qo‘shildi');
    }
    members.unshift(leader);
  }
  let error = null;
  if (!name) error = 'Jamoa nomi yo‘q';
  else if (members.length < 4 || members.length > 8) error = `A’zolar soni ${members.length} ta (4–8 bo‘lishi kerak)`;
  else if (members.some((m) => m.length < 3)) error = 'Ism-familiyasi 3 harfdan qisqa a’zo bor';
  return { name, members, branch, notes, error };
}

module.exports = { cleanRow, fixLetters, samePerson };
