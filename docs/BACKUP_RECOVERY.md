# Backup and recovery

* The server saves a dated database copy to `data/backups/` every 6 hours (keeps the latest 30). **Those are on the same disk** – also copy them elsewhere.
* Download a backup any time: Settings → *Download full backup (.db)* (admin), or `npm run backup`.
* Keep `data/uploads/` (menu images, logo) with the backups.

## Recover
1. Stop the server.
2. `node --no-warnings scripts/restore.js /path/to/backup.db` (checks the file, keeps the current DB as `*.before-restore-*`).
3. Copy `uploads/` back if the disk was lost. Start the server.

## Forgot the admin password
On the server: `node --no-warnings server/cli.js reset-password admin 'NewPassword123'`.

## Recommended routine
Daily copy of `DATA_DIR` to another place (cloud drive, second server, or your phone via the download button). Test a restore once.
