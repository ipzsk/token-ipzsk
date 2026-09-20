"""Run on the server; never prints or replaces credentials."""
import os
import secrets
from pathlib import Path

base = Path(__file__).resolve().parent.parent / "secrets"
base.mkdir(mode=0o700, exist_ok=True)
upstream = base / "upstream"
upstream.mkdir(mode=0o700, exist_ok=True)
(base / "mail").mkdir(mode=0o700, exist_ok=True)
for name in ("db-password", "db-admin-password", "admin-password", "customer-auth-secret"):
    path = base / name
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            file.write(secrets.token_urlsafe(32) + "\n")
source = base / "apimart-primary.key"
target = upstream / "apimart-primary.key"
if source.exists() and not target.exists():
    # Keep one credential copy; do not emit its content.
    source.rename(target)
print("Server credential files prepared; values remain private.")
