# Family Vault

A free, open-source, self-hosted vault for your family's important documents. Runs on [Umbrel](https://umbrel.com).

- Categories (Family, Finance, Property, Passwords, Insurance, Tax, Legal, Business, Employment, Family Resources) plus Contacts
- People and pets, each with their own documents
- Inbox: new uploads get a suggested category you accept or change
- Search across titles, notes, file names, people and contacts
- Expiry dates and reminders
- Logins stored in the Passwords category
- **Encryption**: files and all records are encrypted with AES-256-GCM. The key comes from your passphrase (scrypt) and lives in memory only while the vault is unlocked. Forget the passphrase and the data cannot be recovered.
- Auto-lock, change passphrase, and an encrypted one-click backup (ZIP)

Everything lives in the app's data folder on your Umbrel (`files/*.bin`, `vault.db`, `meta.json`).

## Install on Umbrel
In Umbrel: App Store, three-dot menu, Community App Stores, add `https://github.com/PatriotCrypto/umbrel-family-vault`. Then install Family Vault.

## Run it yourself
```
cd app && npm install && DATA_DIR=./data node server.js
```

## Not affiliated
This is an independent project. It is not affiliated with or endorsed by any commercial document-organizer service.

MIT licensed.
