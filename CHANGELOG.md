# Changelog

## 1.1.1 — 17 Nov 2026 (data format v1)
Improvements from testing with real bank SMS (ICICI, Kotak, SBI, IDFC FASTag, Pluxee):
- Card SMS ("spent using … Card XX… on <date> on MERCHANT") now picks up the merchant; "Avl Limit" cards are recognised as credit cards.
- New debit wordings: SBI "has a debit by NACH", FASTag "txn. of", ICICI "processed payment … Standing Instruction".
- Duplicate check also catches two different messages from the same bank about one payment (e.g. ICICI Standing Instruction + "spent" SMS).
- Transfers between your own accounts are flagged and unticked (a debit with the same amount credited at another bank within 30 minutes).
- Smarter categories: your own rules first, then the most specific keyword; bank-truncated names ("Haritha Vegetab", "Manjilas Medica") still match; ~60 new keywords (fuels, medicals, vegetables, stores, FASTag/toll, Lulu, BookMyShow, Jubilant/Domino's…).
- New payment methods detected: Meal card (Pluxee/Sodexo), FASTag; NACH/standing instructions → Net banking.

## 1.1.0 — 17 Nov 2026 (data format v1, no migration needed)
- **Import from SMS** (Settings): read an SMS Backup & Restore file, pick a date range, review suggested expenses with auto-assigned categories, confirm to add.
- Customisable SMS reading: category rules (built-in list of Indian merchants, add/delete/search/reset), learn-from-changes, skip senders/words/personal numbers, ATM default, fallback category and payment method.
- Duplicate detection across senders and against existing expenses; already-imported messages are never added twice.
- Spreadsheet export now includes recurring payments (Type column) and re-imports them.
- Amounts with paise always show two decimals (₹230.50).
- New optional fields: `settings.sms`; on expenses `source: "sms"` and `smsSender`.

## 1.0.0 — 17 Nov 2026 (data format v1)
- First release: offline installable Android app (PWA), data stored on device (IndexedDB).
- Expenses, categories, payment methods, monthly budget, category and daily charts, search and filters.
- Recurring payments (daily/weekly/monthly/yearly, every N, optional end date, pause/resume).
- Backup/restore (.json, versioned) and spreadsheet export/import (.csv; also reads the earlier claude.ai web version's CSV).
- In-app update prompt; automatic data migration between versions.
