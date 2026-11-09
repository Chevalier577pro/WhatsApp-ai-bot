# 🤖 Bot WhatsApp IA (NVIDIA)

Un bot WhatsApp **100 % en français**, propulsé par les modèles IA de **NVIDIA** (Nemotron 3 Ultra par défaut, et tous les autres modèles du catalogue NVIDIA).
Il se connecte à **ton propre compte WhatsApp** (comme WhatsApp Web) grâce à un **site d'appairage** : tu entres ton numéro, tu reçois un code, c'est connecté.

## ✨ Fonctionnalités

- 🔢 **Site d'appairage** : connexion par code à 8 caractères (ou par QR code), protégée par mot de passe.
- 🔑 **SESSION_ID** : le bot se reconnecte tout seul après chaque redémarrage.
- 🤖 **`.ai`** : un assistant IA répond aux messages de la discussion où tu l'actives.
- 🪞 **`.meai`** : l'IA répond **à ta place**, avec ton style (et se tait si tu réponds toi-même).
- 💬 **IA privée** : active `.ai` dans ta discussion « Moi » pour discuter avec ton IA.
- 📋 **Menu numéroté** (`.menu`, options 1 à 18 et 0) : tout se règle en répondant par un numéro.
- 🧠 **Choix du modèle** parmi tous les modèles NVIDIA (liste paginée, recherche, test automatique).
- 🔒 **Commandes réservées au propriétaire** : seuls TES messages sont lus comme des commandes.
- 🕶️ **Mode discret** : tes commandes sont effacées et les réponses arrivent dans ta discussion « Moi ».
- 👥 **Groupes** : réponse à tous les messages ou seulement quand on te mentionne.
- 🧩 Mémoire par discussion, personnalité, consignes perso, température, délai de réponse, signature…
- ☁️ **Prêt pour GitHub + Render** (`render.yaml` inclus), avec MongoDB en option pour tout conserver.

## 🚀 Installation gratuite en 5 étapes

### 1. Clé API NVIDIA

1. Crée un compte sur [build.nvidia.com](https://build.nvidia.com).
2. Ouvre un modèle (par exemple *Nemotron 3 Ultra*) → **Get API Key** → copie la clé (`nvapi-…`).

### 2. Base MongoDB gratuite (recommandé)

Sur l'offre gratuite de Render, le disque est **effacé à chaque redémarrage**. Avec MongoDB, la session, les réglages et la mémoire sont conservés.

1. Crée un cluster gratuit **M0** sur [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. **Database Access** : crée un utilisateur et un mot de passe.
3. **Network Access** : ajoute `0.0.0.0/0` (Render n'a pas d'adresse IP fixe).
4. **Connect → Drivers** : copie l'adresse `mongodb+srv://…` en remplaçant `<db_password>` par ton mot de passe.

> Sans MongoDB, ça marche aussi : garde simplement la variable `SESSION_ID` à jour (tes réglages et la mémoire seront remis à zéro à chaque redémarrage).

### 3. Mettre le code sur GitHub

Crée un dépôt **privé**, puis envoie les fichiers du projet :

```bash
git init
git add .
git commit -m "Bot WhatsApp IA"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/whatsapp-ai-bot.git
git push -u origin main
```

Tu peux aussi glisser-déposer les fichiers sur github.com (**Add file → Upload files**), sans le dossier `node_modules`.

### 4. Déployer sur Render

1. Sur [render.com](https://render.com) : **New → Blueprint**, puis choisis ton dépôt.
2. Render lit le fichier `render.yaml` et te demande les variables ci-dessous.
3. Clique sur **Apply** et attends la fin du déploiement (2 à 4 minutes).

| Variable | Quoi mettre |
|---|---|
| `NVIDIA_API_KEY` | ta clé NVIDIA (**obligatoire**) |
| `ADMIN_PASSWORD` | un mot de passe pour protéger le site (**fortement recommandé**) |
| `MONGODB_URI` | ton adresse MongoDB (recommandé, sinon laisse vide) |
| `OWNER_NAME` | ton prénom (utile pour le mode `.meai`) |
| `BOT_NAME` | le nom de l'assistant (par défaut « Nova ») |
| `SESSION_ID` | laisse vide pour l'instant |

### 5. Connecter ton WhatsApp

1. Ouvre l'adresse de ton service, par exemple `https://whatsapp-ai-bot.onrender.com`.
2. Entre ton mot de passe admin, puis ton numéro au **format international**, sans le 0 ni le + (ex. `33612345678` pour le 06 12 34 56 78).
3. Clique sur **Obtenir mon code**.
4. Sur ton téléphone : **WhatsApp → Réglages → Appareils connectés → Connecter un appareil → Connecter avec un numéro de téléphone**, puis saisis le code.
5. Une fois connecté, le site affiche ton **SESSION_ID** (le bot te l'envoie aussi dans ta discussion « Moi »).
6. Sur Render : **Environment → SESSION_ID** → colle la valeur → **Save changes**. Le bot redémarre et se reconnecte tout seul. ✅

> ⚠️ Le SESSION_ID donne accès à ton WhatsApp : ne le partage jamais et ne le mets jamais dans le code sur GitHub.

## 💬 Utilisation

Toutes les commandes commencent par `.` et ne marchent **que depuis ton compte** : les messages de tes contacts ne sont jamais lus comme des commandes.
Le plus simple : envoie **`.menu`** dans ta discussion « Moi » (ou dans n'importe quelle discussion), puis réponds par un numéro.

### Le menu `.menu`

| N° | Option |
|---|---|
| 1 | 🤖 Assistant IA ici (on/off) |
| 2 | 🪞 Répondre à ma place ici (on/off) |
| 3 | ⛔ Désactiver l'IA ici |
| 4 | 📋 Discussions actives |
| 5 | 🧠 Choisir le modèle IA |
| 6 | 🎭 Personnalité |
| 7 | 📝 Consignes perso |
| 8 | 👤 Ton prénom |
| 9 | 🏷️ Nom du bot |
| 10 | 🌡️ Créativité (température) |
| 11 | 📏 Longueur max des réponses |
| 12 | 🧩 Mémoire (nombre de messages) |
| 13 | ⏱️ Délai avant réponse |
| 14 | 👥 Comportement en groupe |
| 15 | 🕶️ Mode discret & signature |
| 16 | 🧪 Tester l'IA |
| 17 | 🧹 Effacer la mémoire ici |
| 18 | 🔑 Statut & SESSION_ID |
| 0 | ❌ Fermer le menu |

Quand le bot te demande une valeur, réponds simplement dans la discussion. Tape **0** ou **annuler** pour abandonner (pour la température et le délai, 0 est une vraie valeur : tape **annuler**).
Pour le modèle : un **numéro** pour choisir, **+** pour la page suivante, ou un **mot** pour chercher (ex. `llama`, `qwen`, `deepseek`).

### Les commandes

| Commande | Effet |
|---|---|
| `.menu` | Ouvre le menu numéroté |
| `.ai` · `.ai off` | Active · coupe l'assistant IA dans la discussion |
| `.meai` · `.meai off` | L'IA répond à ta place, dans ton style |
| `.stop` · `.stopall` | Coupe l'IA ici · partout |
| `.actifs` | Discussions où l'IA est active |
| `.ask <question>` | L'IA répond directement dans la discussion |
| `.test [question]` | Teste l'IA (réponse en privé) |
| `.reset` · `.reset tout` | Efface la mémoire de la discussion · de toutes |
| `.models [page ou mot]` | Liste des modèles NVIDIA |
| `.model <numéro ou nom>` | Change de modèle (testé automatiquement) |
| `.perso <texte>` | Personnalité de l'IA |
| `.prompt <texte>` | Consignes perso (infos sur toi, règles…) |
| `.owner <prénom>` | Ton prénom |
| `.nom <nom>` | Nom de l'assistant |
| `.temp <0 à 2>` | Créativité des réponses |
| `.tokens <64 à 8192>` | Longueur max des réponses |
| `.memoire <2 à 100>` | Nombre de messages mémorisés par discussion |
| `.delai <0 à 120>` | Secondes d'attente avant de répondre |
| `.groupes tout` · `.groupes mention` | En groupe : répondre à tout · seulement si on te mentionne |
| `.discret on/off` | Mode discret |
| `.signature on/off` | Signature « — Nova 🤖 » sous les réponses de l'assistant |
| `.reflexion on/off` | Mode réflexion (modèles compatibles) |
| `.reglages` · `.reinit` | Voir · remettre par défaut les réglages |
| `.statut` · `.session` · `.ping` | Statut du bot · ton SESSION_ID · test de vie |
| `.commandes` | Liste de toutes les commandes |

### `.ai` ou `.meai` ?

- **`.ai`** : un assistant (« Nova ») répond aux messages reçus dans la discussion et se présente comme une IA. Dans ta discussion « Moi », c'est ton IA privée.
- **`.meai`** : l'IA répond **en se faisant passer pour toi**, dans ton style. Elle attend le délai choisi (`.delai`, 2 s par défaut) : si tu réponds toi-même avant, elle ne dit rien.
- Les deux modes ne peuvent pas être actifs en même temps dans une discussion.

💡 Pour des réponses `.meai` crédibles, décris-toi avec `.prompt` : âge, ville, études ou métier, centres d'intérêt, façon d'écrire (emojis, abréviations…).

### Mode discret (activé par défaut)

Quand tu tapes une commande dans une discussion, elle est **supprimée pour tout le monde** et la réponse du bot arrive dans ta discussion « Moi ». Ton contact voit seulement « Ce message a été supprimé ». Pour garder les commandes visibles : `.discret off`.

## ⚙️ Variables d'environnement

| Variable | Rôle | Par défaut |
|---|---|---|
| `NVIDIA_API_KEY` | Clé API NVIDIA (**obligatoire**) | — |
| `ADMIN_PASSWORD` | Mot de passe du site d'appairage | — |
| `SESSION_ID` | Session WhatsApp (après l'appairage) | — |
| `MONGODB_URI` | Stockage MongoDB (session, réglages, mémoire) | — |
| `MONGODB_DB` | Nom de la base MongoDB | `whatsapp_ai_bot` |
| `NVIDIA_MODEL` | Modèle utilisé au départ | `nvidia/nemotron-3-ultra-550b-a55b` |
| `NVIDIA_BASE_URL` | Adresse de l'API NVIDIA | `https://integrate.api.nvidia.com/v1` |
| `OWNER_NAME` | Ton prénom | nom de ton profil WhatsApp |
| `BOT_NAME` | Nom de l'assistant | `Nova` |
| `PREFIX` | Préfixe des commandes | `.` |
| `TIME_ZONE` | Fuseau horaire | `Europe/Paris` |
| `LOG_LEVEL` | Niveau de logs (`info`, `debug`…) | `info` |
| `DATA_DIR` | Dossier des données sans MongoDB | `./data` |
| `PORT` | Port du site (fourni par Render) | `3000` |

Les réglages modifiés depuis WhatsApp (`.nom`, `.model`, `.temp`…) sont enregistrés et passent avant les variables d'environnement.

## 💻 Lancer sur ton ordinateur

Il faut **Node.js 20 ou plus récent**.

```bash
npm install
cp .env.example .env   # puis remplis au moins NVIDIA_API_KEY
npm start
```

Ouvre ensuite http://localhost:3000 pour connecter ton WhatsApp. Sans MongoDB, les données sont enregistrées dans le dossier `data/`.
Les tests hors ligne se lancent avec `npm test`.

## 😴 Garder le bot éveillé (Render gratuit)

Le service gratuit de Render s'endort après 15 minutes sans visite. Le bot se rend visite tout seul toutes les 10 minutes pour rester éveillé.
Pour plus de sûreté, crée une sonde gratuite sur [UptimeRobot](https://uptimerobot.com) : type **HTTP(s)**, adresse `https://ton-bot.onrender.com/health`, toutes les 5 minutes.
L'offre gratuite donne 750 heures par mois, assez pour un service allumé 24 h/24.

## 🛠️ Dépannage

| Problème | Solution |
|---|---|
| « Code incorrect » dans WhatsApp | Le code expire vite : redemande un code et saisis-le tout de suite. Vérifie le numéro (indicatif, sans 0 ni +). |
| Statut « Déconnecté » | L'appareil a été retiré dans WhatsApp : refais l'appairage puis remplace `SESSION_ID` sur Render. |
| Statut « Ouvert ailleurs » | Le même SESSION_ID tourne à deux endroits (autre service, ton PC…) : n'en garde qu'un seul. |
| L'IA ne répond pas | Vérifie `NVIDIA_API_KEY`, puis teste avec `.test` (option 16). Les erreurs arrivent dans ta discussion « Moi ». |
| Modèle indisponible (erreur 404) | Choisis-en un autre avec `.models` (option 5). |
| Erreur 429 | Trop de requêtes pour ta clé NVIDIA : patiente un peu ou augmente le délai (`.delai`). |
| Réglages perdus après un redémarrage | Ajoute `MONGODB_URI` : le disque gratuit de Render est effacé à chaque redémarrage. |

## 📁 Structure du projet

```
src/
├── index.js       démarrage du bot
├── config.js      variables d'environnement
├── web/           site d'appairage (server.js + public/index.html)
├── whatsapp/      connexion WhatsApp (Baileys)
├── bot/           messages, commandes, menu, mémoire
├── ai/            client NVIDIA et construction des prompts
├── storage/       stockage fichier ou MongoDB
└── utils/         petits outils (numéros, cache)
test/smoke.js      tests hors ligne (npm test)
```

## ⚠️ Avertissement

Ce bot utilise WhatsApp Web grâce à la bibliothèque non officielle [Baileys](https://github.com/WhiskeySockets/Baileys). Il n'est ni fourni ni approuvé par WhatsApp/Meta : une utilisation abusive (spam, envois en masse) peut faire **bannir ton numéro**. Garde-le pour un usage personnel et préviens tes proches qu'une IA peut leur répondre.
