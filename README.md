# QuizzLive 🎮

Application de quizz interactif type Kahoot — temps réel via WebSockets, base de données SQLite, QR code, images, mode Vrai/Faux, historique.

## Déploiement sur Railway (gratuit, 5 minutes)

### Étape 1 — Créer un compte GitHub
Si vous n'en avez pas : https://github.com/signup

### Étape 2 — Mettre le code sur GitHub
1. Allez sur https://github.com/new
2. Nom du dépôt : `quizzlive`
3. Cliquez **Create repository**
4. Sur la page suivante, copiez les commandes "push an existing repository" et exécutez-les dans ce dossier :

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/VOTRE_PSEUDO/quizzlive.git
git branch -M main
git push -u origin main
```

### Étape 3 — Créer un compte Railway
1. Allez sur https://railway.app
2. Cliquez **Login with GitHub**

### Étape 4 — Déployer
1. Sur Railway, cliquez **New Project**
2. Choisissez **Deploy from GitHub repo**
3. Sélectionnez `quizzlive`
4. Railway détecte automatiquement Node.js et lance le build

### Étape 5 — Ajouter un volume persistant (pour la BDD)
1. Dans votre projet Railway, cliquez sur le service `quizzlive`
2. Onglet **Volumes** → **Add Volume**
3. Mount path : `/data`
4. Cliquez **Add**

### Étape 6 — Récupérer l'URL
1. Onglet **Settings** → **Networking** → **Generate Domain**
2. Votre app est accessible sur `https://quizzlive-xxxx.railway.app`

---

## Lancer en local

```bash
npm install
npm start
```

Puis ouvrez http://localhost:3000

## Structure

```
quizzlive/
├── server.js          # Backend Node.js + WebSockets + SQLite
├── package.json
├── railway.toml       # Config déploiement
└── public/
    └── index.html     # Frontend complet (SPA)
```

## Fonctionnalités

- **Formateur** : créer des quizz (QCM 4 réponses ou Vrai/Faux), ajouter des images, lancer des sessions, voir les résultats en temps réel avec classement animé, historique des sessions, export CSV
- **Participant** : rejoindre via PIN à 6 chiffres ou QR code, répondre aux questions, voir son classement en temps réel
- **Synchronisation** : WebSockets (temps réel instantané, pas de polling)
- **Données** : SQLite avec volume persistant sur Railway
