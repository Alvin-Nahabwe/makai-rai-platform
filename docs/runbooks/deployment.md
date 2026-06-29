# Deployment Runbook

> RAI Toolkit Platform — `rai.air.ug`
> Last updated: 2026-06-29

---

## Overview

This runbook walks through deploying the RAI Toolkit Platform from a bare
Hetzner CX32 VPS to a fully running production environment.

| Item             | Value                                           |
| ---------------- | ----------------------------------------------- |
| Server           | Hetzner CX32 (4 vCPU, 8 GB RAM, 80 GB disk)    |
| OS               | Ubuntu 22.04 LTS                                |
| Domain           | `rai.air.ug`                                    |
| SSL              | Let's Encrypt (Certbot)                         |
| Stack            | Next.js + PostgreSQL 16 + Nginx (Docker)        |
| Compose file     | `docker/docker-compose.prod.yml`                |

---

## 1. Initial Server Setup

### 1.1 SSH into the server

```bash
ssh root@YOUR_SERVER_IP
```

### 1.2 Create a non-root user

```bash
adduser alvin
usermod -aG sudo alvin

# Allow SSH for the new user
rsync --archive --chown=alvin:alvin ~/.ssh /home/alvin
```

### 1.3 Configure the firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 1.4 Update the system

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw
```

### 1.5 Set the timezone

```bash
sudo timedatectl set-timezone Africa/Kampala
timedatectl
```

---

## 2. Install Docker & Docker Compose

```bash
# Install Docker (official method)
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group (avoids needing sudo)
sudo usermod -aG docker alvin

# Apply group change (or log out and back in)
newgrp docker

# Verify installation
docker --version
docker compose version
```

---

## 3. Clone the Repository

```bash
cd /home/alvin/Downloads/DSWB_RAI
git clone https://github.com/YOUR_ORG/toolkit-platform.git
cd toolkit-platform
```

---

## 4. Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

Set production values:

```env
DATABASE_URL="postgresql://makrai:STRONG_PASSWORD_HERE@postgres:5432/makrai"
POSTGRES_DB=makrai
POSTGRES_USER=makrai
POSTGRES_PASSWORD=STRONG_PASSWORD_HERE

NEXTAUTH_SECRET=GENERATE_WITH_openssl_rand_-base64_32
NEXTAUTH_URL=https://rai.air.ug

RESEND_API_KEY=re_your_production_key
ADMIN_EMAIL=admin@air.ug
ADMIN_PASSWORD=STRONG_ADMIN_PASSWORD
ADMIN_NAME="Platform Admin"
```

> **Generate a secret:** `openssl rand -base64 32`
>
> **Generate a strong password:** `openssl rand -base64 24`

---

## 5. SSL Certificate Setup (Certbot)

### 5.1 Install Certbot

```bash
sudo apt install certbot -y
```

### 5.2 Obtain the certificate

Make sure ports 80/443 are not in use (stop Nginx/Docker first if running):

```bash
sudo certbot certonly --standalone -d rai.air.ug
```

Follow the prompts. Certificates will be stored at:

- Certificate: `/etc/letsencrypt/live/rai.air.ug/fullchain.pem`
- Private key: `/etc/letsencrypt/live/rai.air.ug/privkey.pem`

### 5.3 Set up auto-renewal

```bash
# Test renewal
sudo certbot renew --dry-run
```

Add a cron job for automatic renewal:

```bash
sudo crontab -e
```

Add:

```cron
0 2 * * * certbot renew --quiet --pre-hook "docker compose -f /home/alvin/Downloads/DSWB_RAI/toolkit-platform/docker/docker-compose.prod.yml stop nginx" --post-hook "docker compose -f /home/alvin/Downloads/DSWB_RAI/toolkit-platform/docker/docker-compose.prod.yml start nginx"
```

> This stops Nginx at 2 AM, renews if needed, then restarts Nginx. Certbot
> only actually renews when the cert is within 30 days of expiry.

---

## 6. First Deployment

### 6.1 Build and start all services

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform

docker compose -f docker/docker-compose.prod.yml up -d --build
```

This will:
- Build the Next.js app from `docker/Dockerfile`
- Pull `postgres:16-alpine` and `nginx:alpine`
- Start all three services

### 6.2 Verify containers are running

```bash
docker compose -f docker/docker-compose.prod.yml ps
```

All three services (`nextjs`, `postgres`, `nginx`) should show `Up`.

### 6.3 Run database migrations

```bash
docker exec nextjs npx prisma migrate deploy
```

### 6.4 Seed the admin user

```bash
docker exec nextjs npx prisma db seed
```

### 6.5 Verify the deployment

```bash
# Should return 200
curl -s -o /dev/null -w "%{http_code}" https://rai.air.ug

# Check logs for errors
docker compose -f docker/docker-compose.prod.yml logs --tail=50
```

Open `https://rai.air.ug` in a browser and log in with the admin credentials
from your `.env` file.

---

## 7. Monitoring Setup

### 7.1 UptimeRobot (free tier)

1. Go to [https://uptimerobot.com](https://uptimerobot.com) and create an account
2. Add a new monitor:
   - **Type:** HTTP(s)
   - **URL:** `https://rai.air.ug`
   - **Interval:** 5 minutes
   - **Alert contacts:** Add your email / Slack / Telegram
3. Optionally add a keyword monitor checking for a known string on the page

### 7.2 Basic server monitoring (on the VPS)

Check resource usage at any time:

```bash
# Container CPU/memory
docker stats --no-stream

# Disk usage
df -h

# Memory
free -m

# Top processes
htop
```

---

## 8. Update / Redeployment Procedure

When you push new code and want to deploy it:

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform

# Pull the latest code
git pull origin main

# Rebuild and restart (zero-downtime if no schema changes)
docker compose -f docker/docker-compose.prod.yml build nextjs
docker compose -f docker/docker-compose.prod.yml up -d

# Run any new migrations
docker exec nextjs npx prisma migrate deploy
```

**One-liner for simple updates (no migrations):**

```bash
git pull && docker compose -f docker/docker-compose.prod.yml up -d --build
```

---

## 9. Rollback Procedure

If a deployment goes wrong:

### 9.1 Roll back the code

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform

# Find the last known good commit
git log --oneline -10

# Reset to that commit
git checkout <COMMIT_HASH>
```

### 9.2 Rebuild and restart

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
```

### 9.3 Roll back the database (if migrations were applied)

If the new deployment included Prisma migrations that need to be undone:

1. Restore the database from the most recent backup (see
   [backup-restore.md](./backup-restore.md))
2. Then run migrations for the rolled-back code version:

```bash
docker exec nextjs npx prisma migrate deploy
```

### 9.4 Verify

```bash
curl -s -o /dev/null -w "%{http_code}" https://rai.air.ug
docker compose -f docker/docker-compose.prod.yml logs --tail=30 nextjs
```

---

## 10. DNS Configuration

Make sure your DNS is configured before deployment:

| Type  | Name  | Value            | TTL  |
| ----- | ----- | ---------------- | ---- |
| A     | rai   | YOUR_SERVER_IP   | 3600 |
| AAAA  | rai   | YOUR_IPV6 (opt.) | 3600 |

You can verify DNS propagation:

```bash
dig rai.air.ug +short
```

---

## 11. Quick Reference

| Task                   | Command                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| Start all services     | `docker compose -f docker/docker-compose.prod.yml up -d`                      |
| Stop all services      | `docker compose -f docker/docker-compose.prod.yml down`                       |
| Rebuild & restart      | `docker compose -f docker/docker-compose.prod.yml up -d --build`              |
| View logs              | `docker compose -f docker/docker-compose.prod.yml logs -f`                    |
| Run migrations         | `docker exec nextjs npx prisma migrate deploy`                               |
| Seed admin             | `docker exec nextjs npx prisma db seed`                                      |
| Check container status | `docker compose -f docker/docker-compose.prod.yml ps`                        |
| Renew SSL (manual)     | `sudo certbot renew`                                                         |
| Check SSL expiry       | `echo \| openssl s_client -connect rai.air.ug:443 2>/dev/null \| openssl x509 -noout -dates` |
