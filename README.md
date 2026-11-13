# 🤖 Bot WhatsApp IA (NVIDIA)

Un bot WhatsApp **100 % en français**, propulsé par les modèles IA de **NVIDIA** (Nemotron 3 Nano Omni 30B par défaut, et tous les autres modèles du catalogue NVIDIA).
Il se connecte à **ton propre compte WhatsApp** (comme WhatsApp Web) grâce à un **site d'appairage** : tu entres ton numéro, tu reçois un code, c'est connecté.

## ✨ Fonctionnalités

- 🔢 **Site d'appairage** : connexion par code à 8 caractères (ou par QR code), protégée par mot de passe.
- 🔑 **SESSION_ID** : le bot se reconnecte tout seul après chaque redémarrage.
- 🤖 **`.ai`** : un assistant IA répond aux messages de la discussion où tu l'actives.
- 🪞 **`.meai`** : l'IA répond **à ta place**, avec ton style (et se tait si tu réponds toi-même).
- 🙋 **`.aai`** : l'IA te répond **aussi à toi** dans une discussion ou un groupe où `.ai` ou `.meai` est actif.
- 💬 **IA privée** : active `.ai` dans ta discussion « Moi » pour discuter avec ton IA.
- 👁️ **L'IA voit les images** : une photo reçue (avec ou sans légende) est regardée par un modèle de vision NVIDIA avant la réponse (`.vision` pour régler).
- 📎 **L'IA envoie des fichiers** : demande-lui une page `.html`, un `.txt`, un `.csv`, du code… elle l'envoie en pièce jointe (avec `.ai`, `.aai` et `.ask`, pas avec `.meai`).
- ♾️ **Longueur illimitée par défaut** (`.tokens <n>` pour limiter) ; les longues réponses arrivent en plusieurs messages.
- 📋 **Menu numéroté** (`.menu`, options 1 à 21 et 0, par thèmes) : affiche tes réglages actuels et reste ouvert pour enchaîner les numéros.
- 📖 **`.help`** : toutes les commandes par thème ; **`.help <commande>`** donne le détail, des exemples et les autres noms (ex. `.help tokens`).
- 🎵 **`.song`** et 🎬 **`.video`** : un titre (ou un lien) → miniature → choix **MP3 / audio WhatsApp** ou **MP4 / vidéo WhatsApp**. Accessibles **à tout le monde**, pas seulement à toi.
- 🧠 **Choix du modèle** parmi tous les modèles NVIDIA (liste paginée, recherche, test automatique).
- 🔒 **Commandes réservées au propriétaire** : seuls TES messages sont lus comme des commandes, sauf `.song` et `.video` (ouverts à tous).
- 🕶️ **Mode discret** : tes commandes sont effacées et les réponses arrivent dans ta discussion « Moi ».
- 👥 **Groupes** : réponse à tous les messages ou seulement quand on te mentionne.
- 🧩 Mémoire par discussion (**500 messages retenus par défaut**), personnalité, consignes perso, température, délai de réponse, signature…
- ☁️ **Prêt pour GitHub + Render** (`render.yaml` inclus) : fonctionne **sans base de données** (MongoDB en option).

## 🚀 Installation gratuite en 5 étapes

### 1. Clé API NVIDIA

1. Crée un compte sur [build.nvidia.com](https://build.nvidia.com).
2. Ouvre un modèle (par exemple *Nemotron 3 Nano Omni*) → **Get API Key** → copie la clé (`nvapi-…`).

### 2. Base de données (facultatif)

Le bot fonctionne **sans base de données** : la session WhatsApp revient toute seule grâce à `SESSION_ID`.
Sur l'offre gratuite de Render, le disque est **effacé à chaque redémarrage** (redéploiement, mise à jour du code…) : les réglages, les discussions actives (`.ai`, `.meai`, `.aai`) et la mémoire repartent alors à zéro. Pour tout garder, ajoute une base MongoDB gratuite :

1. Crée un cluster gratuit **M0** sur [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. **Database Access** : crée un utilisateur et un mot de passe.
3. **Network Access** : ajoute `0.0.0.0/0` (Render n'a pas d'adresse IP fixe).
4. **Connect → Drivers** : copie l'adresse `mongodb+srv://…` en remplaçant `<db_password>` par ton mot de passe.
5. Sur Render : **Environment → Add Environment Variable** → `MONGODB_URI` = cette adresse.

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

Toutes les commandes commencent par `.` et ne marchent **que depuis ton compte**, sauf **`.song`** et **`.video`** que tes contacts et les groupes peuvent aussi utiliser.
Le plus simple : envoie **`.menu`** dans ta discussion « Moi » (ou dans n'importe quelle discussion), puis réponds par un numéro. Pour voir toutes les commandes : **`.help`** (et **`.help <commande>`** pour le détail).

### Le menu `.menu`

| N° | Option |
|---|---|
| | **🤖 IA dans cette discussion** |
| 1 | 🤖 Assistant IA (on/off) |
| 2 | 🪞 Répondre à ma place (on/off) |
| 3 | 🙋 Me répondre aussi, `.aai` (on/off) |
| 4 | 🛑 Couper l'IA ici |
| 5 | 📋 Discussions actives |
| | **🧠 Intelligence** |
| 6 | 🧠 Modèle |
| 7 | 👁️ Vision des images |
| 8 | 💭 Mode réflexion (on/off) |
| 9 | 🧪 Tester l'IA |
| | **🎨 Personnalisation** |
| 10 | 🎭 Personnalité |
| 11 | 📝 Consignes perso |
| 12 | 👤 Ton prénom |
| 13 | 🏷️ Nom du bot |
| | **⚙️ Réglages** |
| 14 | 🌡️ Créativité (température) |
| 15 | 📏 Longueur max des réponses |
| 16 | 🧩 Mémoire (nombre de messages) |
| 17 | ⏱️ Délai avant réponse |
| 18 | 👥 Comportement en groupe |
| 19 | 🕶️ Mode discret / signature |
| | **🔧 Outils** |
| 20 | 🧹 Effacer la mémoire ici |
| 21 | 📊 Statut & SESSION_ID |
| 0 | ❌ Fermer le menu |

Le menu affiche la valeur actuelle de chaque réglage (✅ / ⛔, modèle, longueur…) et **reste ouvert** : enchaîne les numéros, tape **menu** pour le revoir et **0** pour le fermer (un message qui n'est pas un numéro le ferme aussi).
Quand le bot te demande une valeur, réponds simplement dans la discussion. Tape **0** ou **annuler** pour revenir au menu (pour la température, le délai et la longueur, 0 est une vraie valeur : tape **annuler**).
Pour le modèle : un **numéro** pour choisir, **+** pour la page suivante, ou un **mot** pour chercher (ex. `llama`, `qwen`, `deepseek`).

### Les commandes

| Commande | Effet |
|---|---|
| `.help` | Liste des commandes avec leurs explications |
| `.menu` | Ouvre le menu numéroté |
| `.ai` · `.ai off` | Active · coupe l'assistant IA dans la discussion |
| `.meai` · `.meai off` | L'IA répond à ta place, dans ton style |
| `.aai` · `.aai off` | L'IA te répond aussi à toi dans la discussion (`.ai` ou `.meai` doit être actif) |
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
| `.tokens <64 à 8192>` · `.tokens illimite` | Longueur max des réponses (illimitée par défaut) · aucune limite (le modèle s'arrête à sa propre limite) |
| `.memoire <2 à 500>` | Nombre de messages mémorisés par discussion (500 par défaut) |
| `.delai <0 à 120>` | Secondes d'attente avant de répondre |
| `.groupes tout` · `.groupes mention` | En groupe : répondre à tout · seulement si on te mentionne |
| `.discret on/off` | Mode discret |
| `.signature on/off` | Signature « — Nova 🤖 » sous les réponses de l'assistant |
| `.reflexion on/off` | Mode réflexion (modèles compatibles) |
| `.vision on/off` · `.vision <modèle>` | L'IA regarde les images reçues · modèle de vision utilisé |
| `.reglages` · `.reinit` | Voir · remettre par défaut les réglages |
| `.song <titre ou lien>` | Miniature de la musique, puis **1** = MP3 (fichier) · **2** = audio WhatsApp |
| `.video <titre ou lien>` | Miniature de la vidéo, puis **1** = MP4 (fichier) · **2** = vidéo WhatsApp |
| `.statut` · `.session` · `.ping` | Statut du bot · ton SESSION_ID · test de vie |

### `.ai`, `.meai` et `.aai`

- **`.ai`** : un assistant (« Nova ») répond aux messages reçus dans la discussion et se présente comme une IA. Dans ta discussion « Moi », c'est ton IA privée.
- **`.meai`** : l'IA répond **en se faisant passer pour toi**, dans ton style. Elle attend le délai choisi (`.delai`, 2 s par défaut) : si tu réponds toi-même avant, elle ne dit rien.
- Les deux modes ne peuvent pas être actifs en même temps dans une discussion.
- **`.aai`** : en plus, l'IA **te répond à toi**. Exemple : tu envoies « salut » à un pote, l'IA te répond dans la même discussion (en citant ton message). ��a marche aussi en groupe. Il faut que `.ai` ou `.meai` soit déjà actif ; `.stop` coupe tout.

💡 Pour des réponses `.meai` crédibles, décris-toi avec `.prompt` : âge, ville, études ou métier, centres d'intérêt, façon d'écrire (emojis, abréviations…).

### Mode discret (activé par défaut)

Quand tu tapes une commande dans une discussion, elle est **supprimée pour tout le monde** et la réponse du bot arrive dans ta discussion « Moi ». Ton contact voit seulement « Ce message a été supprimé ». Pour garder les commandes visibles : `.discret off`.

### 🎵 Musique et vidéos : `.song` et `.video`

Ces deux commandes sont **ouvertes à tout le monde** : tes contacts et les membres d'un groupe peuvent les utiliser directement, sans que l'IA soit active. Chaque personne reçoit sa miniature et son fichier dans sa discussion (ou dans le groupe).

```
.song bababoy
.video bababoy
```

1. Le bot cherche sur YouTube et t'envoie la **miniature** (titre, chaîne, durée, lien).
2. Tu réponds **1** ou **2** (directement, ou en citant la miniature) :
   - `.song` → **1** MP3 (fichier, avec pochette et titre) · **2** audio WhatsApp (lecteur audio dans la discussion)
   - `.video` → **1** MP4 (fichier) · **2** vidéo WhatsApp (lecture directe, 480p max)
3. Un message de suivi montre l'avancée : ⏳ téléchargement → 🎛️ conversion → 📤 envoi → ✅.

- Marche aussi avec un **lien** (YouTube et la plupart des sites gérés par yt-dlp : TikTok, Instagram, SoundCloud…) ou en **citant** un message qui contient le titre.
- **0** annule ; un message normal ferme le choix. Les téléchargements passent un par un (file d'attente).
- Limites (modifiables) : 30 min pour `.song`, 15 min pour `.video`, 100 Mo par fichier. Au-delà de 64 Mo, l'audio ou la vidéo part en fichier.
- En mode discret, la miniature et le fichier arrivent dans « Moi ».
- Rien à installer : **yt-dlp** est téléchargé pendant `npm install` (dossier `bin/`, mis à jour tout seul chaque jour) et **ffmpeg** vient du paquet `ffmpeg-static`. Le premier déploiement sur Render est donc un peu plus long.

**Si YouTube bloque le serveur** (« confirme que tu n'es pas un robot »), ce qui arrive souvent avec les serveurs d'hébergeurs comme Render :

1. Sur ton ordinateur, connecte-toi à YouTube (de préférence avec un compte secondaire) et exporte les cookies au format `cookies.txt` (par exemple avec l'extension « Get cookies.txt LOCALLY »).
2. Sur Render → ton service → **Environment** → **Secret Files** : ajoute un fichier nommé `cookies.txt` avec ce contenu. (Autre solution : colle le contenu, brut ou encodé en base64, dans la variable `YT_COOKIES`.)
3. Redéploie : `.statut` affiche « cookies YouTube ✅ ».

⚠️ Ne mets jamais `cookies.txt` sur GitHub (il est dans `.gitignore`) : il donne accès à ton compte YouTube.

## ⚙️ Variables d'environnement

| Variable | Rôle | Par défaut |
|---|---|---|
| `NVIDIA_API_KEY` | Clé API NVIDIA (**obligatoire**) | — |
| `ADMIN_PASSWORD` | Mot de passe du site d'appairage | — |
| `SESSION_ID` | Session WhatsApp (après l'appairage) | — |
| `MONGODB_URI` | Facultatif : base MongoDB pour garder réglages et mémoire | — |
| `MONGODB_DB` | Nom de la base MongoDB | `whatsapp_ai_bot` |
| `NVIDIA_MODEL` | Modèle utilisé au départ | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` |
| `NVIDIA_VISION_MODEL` | Modèle qui regarde les images (doit accepter les images) | `nvidia/nemotron-3.5-super-vl-120b-a12b` |
| `NVIDIA_BASE_URL` | Adresse de l'API NVIDIA | `https://integrate.api.nvidia.com/v1` |
| `OWNER_NAME` | Ton prénom | nom de ton profil WhatsApp |
| `BOT_NAME` | Nom de l'assistant | `Nova` |
| `PREFIX` | Préfixe des commandes | `.` |
| `TIME_ZONE` | Fuseau horaire | `Europe/Paris` |
| `LOG_LEVEL` | Niveau de logs (`info`, `debug`…) | `info` |
| `DATA_DIR` | Dossier des données sans MongoDB | `./data` |
| `PORT` | Port du site (fourni par Render) | `3000` |
| `YT_COOKIES` | `.song`/`.video` : cookies YouTube (contenu de cookies.txt, brut ou base64) si YouTube bloque le serveur | — |
| `YT_COOKIES_FILE` | Chemin d'un fichier cookies.txt (le Secret File Render `cookies.txt` est lu tout seul) | — |
| `SONG_MAX_MINUTES` · `VIDEO_MAX_MINUTES` | Durée max pour `.song` · `.video` | `30` · `15` |
| `VIDEO_MAX_HEIGHT` | Hauteur max des vidéos | `480` |
| `MEDIA_MAX_MB` | Taille max d'un fichier envoyé | `100` |
| `YTDLP_PATH` · `FFMPEG_PATH` · `YTDLP_ARGS` | Avancé : chemins perso, options yt-dlp en plus | — |

Les réglages modifiés depuis WhatsApp (`.nom`, `.model`, `.temp`…) sont enregistrés et passent avant les variables d'environnement.

## 💻 Lancer sur ton ordinateur

Il faut **Node.js 20 ou plus récent** (22 conseillé pour `.song`/`.video`).

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
| L'IA ne répond pas | Vérifie `NVIDIA_API_KEY`, puis teste avec `.test` (option 9 du menu). Les erreurs arrivent dans ta discussion « Moi ». |
| « Active d'abord .ai ou .meai » | `.aai` a besoin que `.ai` ou `.meai` soit déjà actif dans la discussion. |
| Modèle indisponible (erreur 404) | Choisis-en un autre avec `.models` (option 6 du menu). |
| Erreur 429 | Trop de requêtes pour ta clé NVIDIA : patiente un peu ou augmente le délai (`.delai`). |
| Réglages perdus après un redémarrage | Normal sans base de données : le disque gratuit de Render est effacé à chaque redémarrage. Réactive `.ai` / `.meai` / `.aai`, ou ajoute `MONGODB_URI` pour tout garder. |
| `.song`/`.video` : « YouTube bloque le serveur » | Ajoute tes cookies YouTube (voir « Musique et vidéos »). |
| `.song`/`.video` : « Aucun format » ou erreur 403 | yt-dlp se met à jour tout seul chaque jour ; redéploie sur Render pour forcer la dernière version. |
| Fichier trop lourd ou trop long | Augmente `MEDIA_MAX_MB`, `SONG_MAX_MINUTES` ou `VIDEO_MAX_MINUTES`. |

## 📁 Structure du projet

```
src/
├── index.js       démarrage du bot
├── config.js      variables d'environnement
├── web/           site (server.js + public/ : page, styles, scène 3D, catalogue des commandes)
├── whatsapp/      connexion WhatsApp (Baileys)
├── bot/           messages, commandes, menu, mémoire
├── ai/            client NVIDIA et construction des prompts
├── storage/       stockage fichier ou MongoDB
├── media/         .song / .video : recherche YouTube, yt-dlp, ffmpeg
└── utils/         petits outils (numéros, cache)
scripts/           téléchargement de yt-dlp (npm install)
test/smoke.js      tests hors ligne (npm test)
test/media-e2e.js  test complet .song/.video avec les vrais outils
```

## ⚠️ Avertissement

Ce bot utilise WhatsApp Web grâce à la bibliothèque non officielle [Baileys](https://github.com/WhiskeySockets/Baileys). Il n'est ni fourni ni approuvé par WhatsApp/Meta : une utilisation abusive (spam, envois en masse) peut faire **bannir ton numéro**. Garde-le pour un usage personnel et préviens tes proches qu'une IA peut leur répondre.
