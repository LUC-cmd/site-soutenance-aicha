# Site de soutenance — TCHAKONDO Aïcha

**Analyse du système de gestion du courrier administratif dans une collectivité locale : cas de la Mairie de Doumassessé (Commune du Golfe 3)**

Rapport de fin de formation · Licence professionnelle en Assistance administrative · Université de Kara · 2025-2026

## Contenu du site
- Le mémoire en bref, la carte interactive (du Togo à la mairie), les problèmes et solutions, la GED, une démonstration de registre numérique, les bénéfices pour la population et le plan d’action.
- **Documents** : le rapport et la présentation, lisibles en ligne, avec codes QR à scanner.
- **Espace privé** (cadenas) : dépôt et gestion des documents par l’autrice (voir `config.js`).

## Hébergement (Railway)
- Le site est servi par `server.js` (Node 18+), qui fournit aussi l’API des documents.
- Base de données : un service **PostgreSQL** dans le même projet Railway.
- Variables du service du site :
  - `DATABASE_URL` → référence à la base PostgreSQL (`${{Postgres.DATABASE_URL}}`)
  - `ADMIN_EMAIL` → adresse de connexion de l’autrice
  - `ADMIN_PASSWORD` → mot de passe (8 caractères minimum)
- Sans base de données, le site reste consultable avec les documents du dossier `docs/`.
