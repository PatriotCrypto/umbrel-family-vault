# Family Vault

A free, open-source, self-hosted vault for your family's important documents. Runs on [Umbrel](https://umbrel.com/).

Your passports, insurance policies, tax returns, wills and medical records stay on your own hardware, encrypted, instead of in someone else's cloud.

## Features

**Organize**
- Categories: Family, Finance, Property, Passwords, Insurance, Tax, Legal, Business and Family Resources, plus your own custom categories (add, rename or delete them in Settings)
- Documents are grouped by family member, and each person has their own page with a profile photo
- Tile view or row view, remembered between visits
- Quick views: one click shows everyone's Birth Certificate, Passport Book, Passport Card, Driver's License / Permit or Social Security Card side by side, and flags who is missing one
- Contacts for your attorney, doctor, accountant and others
- Search across titles, notes, file names, people and contacts

**Add documents quickly**
- Drop files into the Inbox: the category, person and title are guessed from the file name, and you accept or change them
- Thumbnails and a full preview (images, multi-page PDFs and text files) without leaving the page

**Stay on top of renewals**
- Expiry dates and reminders, grouped into Overdue, Next 30 days and Later
- A Renew button on anything expired or expiring soon: set the new date and upload the replacement document or photo
- Optional phone alerts through [ntfy](https://ntfy.sh/), sent by your Umbrel even while the vault is locked

**Bitcoin**
- A page for recording where wallets, accounts and recovery instructions are kept (describe where seed phrases are; never type them in)
- Track balances by public address or by wallet key (xpub, ypub or zpub), with transaction counts. Seed phrases and private keys are rejected.
- Lookups use mempool.space by default. Point them at your own Mempool node for full privacy, or turn them off.

**Everything else**
- Logins stored in the Passwords category, with a password generator
- A printable emergency sheet listing what exists and where, never passwords
- Five themes (Classic, Bright, Midnight, Retro 95 and 8-Bit) and a family name on the home page
- Auto-lock, change passphrase, and an encrypted one-click backup with restore

## Security

- Files and all records are encrypted with AES-256-GCM. A random master key does the encrypting, and that key is itself locked by a key derived from your passphrase using scrypt.
- Changing your passphrase is instant and safe, because only the master key's lock is replaced.
- The passphrase is never stored, and the master key lives in memory only while the vault is unlocked. **If you forget the passphrase, the data cannot be recovered.**
- Each browser gets its own session. Requests are protected against cross-site forgery, and a strict content security policy is applied.
- The container runs with a read-only filesystem, all Linux capabilities dropped except the three it needs at start-up, and no new privileges.
- Previews are drawn in your browser. Thumbnails are kept in memory only and never saved to disk.
- Everything lives in the app's data folder on your Umbrel: `meta.json` (the wrapped key and settings), `vault.db` and `files/*.bin`, all encrypted except the small `meta.json` and the optional ntfy settings described below.

**Things to know**
- Alerts through ntfy work while the vault is locked, so a small schedule (dates and generic labels; titles only if you opt in) is kept unencrypted. Anyone who knows your ntfy topic can read your alerts on a public ntfy server, so keep the topic secret or use your own server.
- Tracking a wallet key lets the lookup server see all of that wallet's addresses.
- This project has not been independently audited. Use a long passphrase (five or more random words is a good choice) and keep backups somewhere other than the Umbrel itself.

## Install on Umbrel

In Umbrel: App Store, three-dot menu, Community App Stores, add `https://github.com/PatriotCrypto/umbrel-family-vault`. Then install Family Vault.

## Upgrading from an older version

Vaults created before 0.3.0 use an older key setup. When you open one you'll see an "Upgrade encryption" button. It re-encrypts everything under the stronger setup, keeps all your data, and leaves your vault untouched if anything goes wrong. Download a backup first.

## Backup and restore

Settings has a **Download encrypted backup** button. The ZIP is useless without your passphrase, so keep copies away from your Umbrel. To restore, choose "Restore from a backup" on the setup screen of a fresh install, then unlock with your original passphrase.

## Run it yourself

```
cd app && npm install && DATA_DIR=./data node server.js
```

Then open http://localhost:3000. A Docker image is published at `ghcr.io/patriotcrypto/family-vault`.

## Not affiliated

This is an independent project. It is not affiliated with or endorsed by any commercial document-organizer service.

MIT licensed.
