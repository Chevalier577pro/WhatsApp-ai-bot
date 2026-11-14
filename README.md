# 🤖 Bot WhatsApp IA (NVIDIA)

Un bot WhatsApp **100 % en français**, propulsé par les modèles IA de **NVIDIA** (Nemotron 3 Nano Omni 30B par défaut, et tous les autres modèles du catalogue NVIDIA).
Il se connecte à **ton propre compte WhatsApp** (comme WhatsApp Web) grâce à un **site d'appairage** : tu entres ton numéro, tu reçois un code, c'est connecté.

## ✨ Fonctionnalités

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e36936025427278575447eaaa60dff54b92d3527cecae2f5882c5d781ad75a26 -->

- 🔢 **Site public séparé** : chacun génère son SESSION_ID par code ou QR, sans accès au compte des autres.

<!-- /coderabbit-ai-generated:v1 -->
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

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b5862fd6b4c9fff5a9cfff56860aa76110198dde3624b845cd59bf5b57ca5627 -->

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:28c34df7bbc2e3e9b0a6dd27aa180692c34f6a0354ae214e70a64a5a1da768c1 -->

## 🚀 Installer ton propre bot

Le dépôt public contient le bot et son point de contrôle HTTP. Le site de génération des sessions et l’administration sont hébergés séparément et leur code est privé.

### 1. Récupérer le bot

Sur [GitHub](https://github.com/y8658945-blip/WhatsApp-ai-bot), clique sur **Fork** pour créer ta copie. Tu peux aussi travailler en local avec Node.js 22 :

```bash
git clone https://github.com/y8658945-blip/WhatsApp-ai-bot.git
cd WhatsApp-ai-bot
npm install
cp .env.example .env
```

### 2. Générer ton SESSION_ID

1. Ouvre le [site public](https://whatsapp-ai-bot-tenm.onrender.com/#connect). Son [tutoriel](https://whatsapp-ai-bot-tenm.onrender.com/#guide) détaille l’installation.
2. Entre ton numéro au format international (exemple fictif : `33612345678`) et demande un code, ou choisis le QR code.
3. Dans WhatsApp : **Réglages → Appareils connectés → Connecter un appareil → Connecter avec un numéro de téléphone**, puis saisis le code. Pour le QR, scanne-le depuis ce menu.
4. Copie le `SESSION_ID` affiché. Chaque visiteur a sa propre connexion, accessible uniquement depuis son onglet. Aucun mot de passe admin n’est nécessaire.
5. La session temporaire expire après **10 minutes** ; le code expire après environ **3 minutes**. Copie le SESSION_ID avant l’expiration. Le site ferme sa connexion lors de la récupération du SESSION_ID pour laisser ton bot prendre le relais, sans révoquer l’appareil WhatsApp.

Le site génère des identifiants ; chaque utilisateur héberge son propre bot. Il n’héberge pas un bot permanent pour chaque visiteur. Une limite de connexions simultanées peut demander de patienter. Après un redémarrage du site, recommence si ton onglet a expiré.

> Le SESSION_ID donne accès à ton WhatsApp. Garde-le dans les variables d’environnement, jamais dans un dépôt, une capture ou un message public. Une seule instance doit utiliser une session donnée.

### 3. Configurer l’IA

Crée ta clé sur [NVIDIA Build](https://build.nvidia.com) (**Get API Key**). Mets `NVIDIA_API_KEY` et `SESSION_ID` dans ton fichier local `.env` ou les variables de ton hébergeur. Les clés de l’hébergeur du site ne sont pas partagées avec les visiteurs.

### 4. Lancer le bot

**En local** : `npm start`, puis envoie `.menu` dans ta discussion WhatsApp « Moi ».

**Sur Render** : **New → Blueprint**, sélectionne ton fork contenant `render.yaml`, puis renseigne `NVIDIA_API_KEY`, `SESSION_ID` et les paramètres souhaités (`BOT_NAME`, `OWNER_NAME`). Si GitHub ne propose pas ton fork, autorise-le dans l’intégration GitHub de Render. Consulte les [instructions Render](https://render.com/docs/blueprint-spec).

Ce service expose `/health` pour Render ; il n’a pas d’interface d’appairage ni de page admin. Pour refaire l’appairage, retourne sur le site public et remplace `SESSION_ID`.

### 5. Conserver les réglages (facultatif)

Sans MongoDB, le bot écrit dans `DATA_DIR`. Sur une instance Render au disque éphémère, les réglages et la mémoire peuvent disparaître lors d’un redéploiement. `SESSION_ID` permet la reconnexion. Pour conserver aussi les réglages, configure `MONGODB_URI` et `MONGODB_DB` avec une base accessible au service.



<!-- /coderabbit-ai-generated:v1 -->## 💬 Utilisation

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
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:2e2f70b7434bf909c04d2d7032cc8b1b6e4559e0725e9401c576c9df49327806 -->

| `PUBLIC_URL` | URL publique du service (facultatif) | — |

<!-- /coderabbit-ai-generated:v1 -->
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
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:4182a624cdb644aaa1af3b3f20a3561584cd8adcbd108bc65884431464ce81de -->

| `PORT` | Port HTTP de santé (fourni par Render) | `3000` |

<!-- /coderabbit-ai-generated:v1 -->
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
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e357b119e88d8c9e1449e135641b280886d71707c8ce107eaaac3699907bd6f0 -->

├── health.js      contrôle de santé HTTP (aucun site embarqué)

<!-- /coderabbit-ai-generated:v1 -->
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
