#!/usr/bin/env node
/**
 * Engendre les pages de `landing/` : l'accueil et la page de confidentialité, dans les six
 * langues, depuis un seul gabarit et un dictionnaire par langue.
 *
 *   node scripts/landing-gen.mjs && npx prettier --write landing
 *
 * La version affichée vient de `package.json` ; `landing-version.mjs` la réécrit ensuite à la
 * publication, sur les mêmes motifs. Les pages engendrées sont commises : le site se lit sans
 * outil, et `check-landing.mjs` les contrôle telles qu'elles sont servies.
 *
 * ⚠️ Modifier un texte se fait ICI, jamais dans `landing/` : la prochaine génération écraserait
 * la retouche faite à la main.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const DMG = `https://github.com/romsau/mirmalion/releases/download/v${VERSION}/Mirmalion_${VERSION}_aarch64.dmg`;
const SITE = 'https://mirmalion.web.app/';
const REPO = 'https://github.com/romsau/mirmalion';
const MEASUREMENT_ID = 'G-69VB32R303';
const CODES = ['fr', 'en', 'es', 'de', 'it', 'pt'];
const NATIVE = {
  fr: 'Français',
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  it: 'Italiano',
  pt: 'Português',
};
/** Le dossier de la page de confidentialité, dans la langue de chaque page. */
const NOTICE_SLUG = {
  fr: 'confidentialite',
  en: 'privacy',
  es: 'privacidad',
  de: 'datenschutz',
  it: 'privacy',
  pt: 'privacidade',
};

const T = {
  fr: {
    title: 'Mirmalion — la dictée et la transcription, sur votre Mac',
    description:
      'Dictée, transcription en direct et transcription de fichiers audio ou vidéo. Tout se passe sur votre Mac, hors ligne : aucun son, aucun texte ne quitte la machine.',
    navLabel: 'Sections de la page',
    langLabel: 'Langue',
    github: 'Le dépôt GitHub de Mirmalion, pour écrire à l’auteur',
    ids: { dictee: 'dictee', direct: 'direct', fichiers: 'fichiers' },
    nav: { dictee: 'Dictée', direct: 'Direct', fichiers: 'Fichiers', local: 'Hors ligne' },
    logoAlt: 'Logo Mirmalion',
    h1: 'Vous parlez, Mirmalion écrit.',
    lede: "Dictez dans n'importe quelle application, suivez une conférence dans une autre langue avec le texte en direct, ou transcrivez un fichier. Sur votre Mac, sans réseau.",
    download: 'Télécharger Mirmalion',
    meta1: 'macOS 26 · Apple Silicon · Gratuit, code ouvert',
    meta2: 'Français, anglais, espagnol, allemand, italien, portugais.',
    dictee: {
      h2: "Vous parlez, le texte s'écrit là où est votre curseur.",
      p1a: 'Un raccourci, ',
      p1b: ", et vous dictez dans n'importe quelle application. Le texte s'insère à l'endroit exact où vous étiez, ponctué et propre.",
      p2a: 'Un second raccourci, ',
      p2b: ', écrit directement dans la langue de votre choix. Un dictionnaire personnel apprend vos noms propres et vos termes de métier.',
      alt: "L'écran Dictée de Mirmalion : mode de dictée, langue parlée, traduction, reformulation.",
    },
    direct: {
      h2: 'Une conférence dans une autre langue, lisible en direct.',
      p1: 'Vous suivez une conférence en anglais, une visio en espagnol, une vidéo en allemand : Mirmalion capte le son de votre Mac et affiche le texte au fur et à mesure, traduit dans votre langue si vous le souhaitez.',
      p2: 'À la fin, un compte rendu rédigé sur votre machine par un modèle de langage local, et un export du texte.',
      alt: "L'écran Direct de Mirmalion : source audio, langue parlée, traduction, et le bouton Démarrer l'enregistrement.",
    },
    fichiers: {
      h2: 'Un enregistrement, glissé, transcrit.',
      p1: 'Déposez un fichier audio ou vidéo, et récupérez son texte. Aucune adresse à coller, aucun envoi : le fichier ne quitte pas votre disque.',
      alt: "Le panneau Fichiers des Options : glissez un fichier audio ou vidéo, ou parcourez l'ordinateur.",
    },
    local: {
      h2: 'Rien ne sort de votre machine.',
      p1: "Toutes les fonctions marchent sans réseau. Aucune télémétrie, aucun compte, aucun contenu envoyé nulle part. Le réseau ne sert qu'à deux gestes explicites : télécharger une langue, mettre à jour l'application.",
      listLabel: 'Langues gérées',
      langs: ['Français', 'Anglais', 'Espagnol', 'Allemand', 'Italien', 'Portugais'],
    },
    foot: {
      linksLabel: 'Liens',
      source: 'Code source',
      releases: 'Toutes les versions',
      license: 'Licence MIT',
      p: 'Mirmalion est un logiciel libre pour macOS 26 sur Apple Silicon.',
    },
    consent: {
      label: "Mesure d'audience",
      text: 'Ce site compte ses visites avec Google Analytics, sans publicité. Vous pouvez refuser.',
      more: 'En savoir plus',
      yes: 'Accepter',
      no: 'Refuser',
    },
    notice: {
      title: 'Confidentialité — Mirmalion',
      link: 'Confidentialité',
      h1: 'Confidentialité',
      date: 'Mise à jour le 11 septembre 2026.',
      intro:
        "L'application Mirmalion ne collecte rien : tout se passe sur votre Mac, sans compte ni télémétrie. Cette page décrit ce que fait le site mirmalion.web.app, et lui seul.",
      sections: [
        {
          h2: "Mesure d'audience",
          p: [
            "Avec votre accord, le site compte ses visites avec Google Analytics, un service de Google Ireland Limited. Il enregistre les pages vues, le pays approximatif, le type d'appareil et de navigateur, et la provenance de la visite. Les signaux publicitaires et la personnalisation sont désactivés.",
            "Sans votre accord, rien n'est mesuré. Votre choix est retenu treize mois dans votre navigateur, et le lien « Mesure d'audience » en bas de chaque page permet d'en changer à tout moment. Google conserve ces données deux mois.",
          ],
        },
        {
          h2: 'Hébergement',
          p: [
            'Le site est hébergé par Firebase Hosting, un service de Google. Comme tout hébergeur, il tient des journaux techniques, adresse IP et page demandée, pour la sécurité et le bon fonctionnement du service.',
          ],
        },
        {
          h2: 'Téléchargement et GitHub',
          p: [
            "Le bouton de téléchargement et le lien GitHub mènent sur github.com, qui applique sa propre politique de confidentialité. Écrire à l'auteur passe par les issues du dépôt : ce que vous y publiez est visible de tous.",
          ],
        },
        {
          h2: 'Vos droits',
          p: [
            "Vous pouvez demander l'accès à vos données ou leur suppression, ou poser toute question, en ouvrant une issue sur GitHub. Vous pouvez aussi saisir la CNIL.",
          ],
        },
        {
          h2: 'Responsable',
          p: ["Le site est publié par l'auteur de Mirmalion, joignable sur GitHub."],
        },
      ],
    },
  },
  en: {
    title: 'Mirmalion — dictation and transcription, on your Mac',
    description:
      'Dictation, live transcription and transcription of audio or video files. Everything runs on your Mac, offline: no sound and no text ever leaves the machine.',
    navLabel: 'Page sections',
    langLabel: 'Language',
    github: 'The Mirmalion repository on GitHub, to write to the author',
    ids: { dictee: 'dictation', direct: 'live', fichiers: 'files' },
    nav: { dictee: 'Dictation', direct: 'Live', fichiers: 'Files', local: 'Offline' },
    logoAlt: 'Mirmalion logo',
    h1: 'You speak, Mirmalion writes.',
    lede: 'Dictate in any application, follow a conference in another language with the text live, or transcribe a file. On your Mac, without a network.',
    download: 'Download Mirmalion',
    meta1: 'macOS 26 · Apple Silicon · Free, open source',
    meta2: 'French, English, Spanish, German, Italian, Portuguese.',
    dictee: {
      h2: 'You speak, the text lands right where your cursor is.',
      p1a: 'One shortcut, ',
      p1b: ', and you dictate into any application. The text is inserted exactly where you were, punctuated and clean.',
      p2a: 'A second shortcut, ',
      p2b: ", writes straight into the language of your choice. A personal dictionary learns your names and your trade's vocabulary.",
      alt: 'The Dictation screen in Mirmalion: dictation mode, spoken language, translation, rephrasing.',
    },
    direct: {
      h2: 'A conference in another language, readable live.',
      p1: "You're following a conference in German, a video call in Spanish, a video in Italian: Mirmalion captures the sound on your Mac and displays the text as it goes, translated into your language if you want.",
      p2: 'At the end, a summary written on your machine by a local language model, and an export of the text.',
      alt: 'The Live screen in Mirmalion: audio source, spoken language, translation, and the Start Recording button.',
    },
    fichiers: {
      h2: 'A recording, dropped, transcribed.',
      p1: 'Drop an audio or video file and get its text back. No link to paste, no upload: the file never leaves your disk.',
      alt: 'The Files panel in Options: drop an audio or video file, or browse your computer.',
    },
    local: {
      h2: 'Nothing leaves your machine.',
      p1: 'Every feature works without a network. No telemetry, no account, no content sent anywhere. The network is only used for two explicit actions: downloading a language, and updating the app.',
      listLabel: 'Supported languages',
      langs: ['French', 'English', 'Spanish', 'German', 'Italian', 'Portuguese'],
    },
    foot: {
      linksLabel: 'Links',
      source: 'Source code',
      releases: 'All releases',
      license: 'MIT license',
      p: 'Mirmalion is free software for macOS 26 on Apple Silicon.',
    },
    consent: {
      label: 'Analytics',
      text: 'This site counts its visits with Google Analytics, without advertising. You can decline.',
      more: 'Learn more',
      yes: 'Accept',
      no: 'Decline',
    },
    notice: {
      title: 'Privacy — Mirmalion',
      link: 'Privacy',
      h1: 'Privacy',
      date: 'Updated 11 September 2026.',
      intro:
        'The Mirmalion app collects nothing: everything happens on your Mac, with no account and no telemetry. This page describes what the website mirmalion.web.app does, and only that.',
      sections: [
        {
          h2: 'Analytics',
          p: [
            'With your consent, the site counts its visits with Google Analytics, a service of Google Ireland Limited. It records pages viewed, approximate country, device and browser type, and where the visit came from. Advertising signals and personalisation are turned off.',
            'Without your consent, nothing is measured. Your choice is kept for thirteen months in your browser, and the “Analytics” link at the bottom of every page lets you change it at any time. Google keeps this data for two months.',
          ],
        },
        {
          h2: 'Hosting',
          p: [
            'The site is hosted on Firebase Hosting, a Google service. Like any host, it keeps technical logs, IP address and requested page, for the security and operation of the service.',
          ],
        },
        {
          h2: 'Download and GitHub',
          p: [
            "The download button and the GitHub link lead to github.com, which applies its own privacy policy. Writing to the author goes through the repository's issues: what you post there is public.",
          ],
        },
        {
          h2: 'Your rights',
          p: [
            'You can ask for access to your data or its deletion, or ask any question, by opening an issue on GitHub. You can also lodge a complaint with your data protection authority.',
          ],
        },
        {
          h2: 'Publisher',
          p: ['The site is published by the author of Mirmalion, reachable on GitHub.'],
        },
      ],
    },
  },
  es: {
    title: 'Mirmalion — dictado y transcripción, en tu Mac',
    description:
      'Dictado, transcripción en directo y transcripción de archivos de audio o vídeo. Todo ocurre en tu Mac, sin conexión: ningún sonido ni texto sale de la máquina.',
    navLabel: 'Secciones de la página',
    langLabel: 'Idioma',
    github: 'El repositorio de Mirmalion en GitHub, para escribir al autor',
    ids: { dictee: 'dictado', direct: 'directo', fichiers: 'archivos' },
    nav: { dictee: 'Dictado', direct: 'Directo', fichiers: 'Archivos', local: 'Sin conexión' },
    logoAlt: 'Logotipo de Mirmalion',
    h1: 'Tú hablas, Mirmalion escribe.',
    lede: 'Dicta en cualquier aplicación, sigue una conferencia en otro idioma con el texto en directo, o transcribe un archivo. En tu Mac, sin red.',
    download: 'Descargar Mirmalion',
    meta1: 'macOS 26 · Apple Silicon · Gratis, código abierto',
    meta2: 'Francés, inglés, español, alemán, italiano, portugués.',
    dictee: {
      h2: 'Tú hablas, el texto se escribe justo donde está tu cursor.',
      p1a: 'Un atajo, ',
      p1b: ', y dictas en cualquier aplicación. El texto se inserta en el punto exacto donde estabas, puntuado y limpio.',
      p2a: 'Un segundo atajo, ',
      p2b: ', escribe directamente en el idioma que elijas. Un diccionario personal aprende tus nombres propios y los términos de tu oficio.',
      alt: 'La pantalla Dictado de Mirmalion: modo de dictado, idioma hablado, traducción, reformulación.',
    },
    direct: {
      h2: 'Una conferencia en otro idioma, legible en directo.',
      p1: 'Sigues una conferencia en inglés, una videollamada en alemán, un vídeo en italiano: Mirmalion capta el sonido de tu Mac y muestra el texto sobre la marcha, traducido a tu idioma si lo deseas.',
      p2: 'Al final, un resumen redactado en tu máquina por un modelo de lenguaje local, y una exportación del texto.',
      alt: 'La pantalla Directo de Mirmalion: fuente de audio, idioma hablado, traducción y el botón Empezar a grabar.',
    },
    fichiers: {
      h2: 'Una grabación, arrastrada, transcrita.',
      p1: 'Suelta un archivo de audio o vídeo y recupera su texto. Ninguna dirección que pegar, ningún envío: el archivo no sale de tu disco.',
      alt: 'El panel Archivos de las Opciones: arrastra un archivo de audio o vídeo, o explora el ordenador.',
    },
    local: {
      h2: 'Nada sale de tu máquina.',
      p1: 'Todas las funciones trabajan sin red. Sin telemetría, sin cuenta, sin contenido enviado a ningún sitio. La red solo sirve para dos gestos explícitos: descargar un idioma y actualizar la aplicación.',
      listLabel: 'Idiomas disponibles',
      langs: ['Francés', 'Inglés', 'Español', 'Alemán', 'Italiano', 'Portugués'],
    },
    foot: {
      linksLabel: 'Enlaces',
      source: 'Código fuente',
      releases: 'Todas las versiones',
      license: 'Licencia MIT',
      p: 'Mirmalion es software libre para macOS 26 en Apple Silicon.',
    },
    consent: {
      label: 'Medición de audiencia',
      text: 'Este sitio cuenta sus visitas con Google Analytics, sin publicidad. Puedes rechazarlo.',
      more: 'Más información',
      yes: 'Aceptar',
      no: 'Rechazar',
    },
    notice: {
      title: 'Privacidad — Mirmalion',
      link: 'Privacidad',
      h1: 'Privacidad',
      date: 'Actualizado el 11 de septiembre de 2026.',
      intro:
        'La aplicación Mirmalion no recoge nada: todo ocurre en tu Mac, sin cuenta ni telemetría. Esta página describe lo que hace el sitio mirmalion.web.app, y solo él.',
      sections: [
        {
          h2: 'Medición de audiencia',
          p: [
            'Con tu consentimiento, el sitio cuenta sus visitas con Google Analytics, un servicio de Google Ireland Limited. Registra las páginas vistas, el país aproximado, el tipo de dispositivo y de navegador, y la procedencia de la visita. Las señales publicitarias y la personalización están desactivadas.',
            'Sin tu consentimiento, no se mide nada. Tu elección se guarda trece meses en tu navegador, y el enlace « Medición de audiencia » al pie de cada página permite cambiarla en cualquier momento. Google conserva estos datos dos meses.',
          ],
        },
        {
          h2: 'Alojamiento',
          p: [
            'El sitio está alojado en Firebase Hosting, un servicio de Google. Como todo alojador, guarda registros técnicos, dirección IP y página solicitada, para la seguridad y el funcionamiento del servicio.',
          ],
        },
        {
          h2: 'Descarga y GitHub',
          p: [
            'El botón de descarga y el enlace a GitHub llevan a github.com, que aplica su propia política de privacidad. Escribir al autor pasa por las issues del repositorio: lo que publiques allí es visible para todos.',
          ],
        },
        {
          h2: 'Tus derechos',
          p: [
            'Puedes pedir acceso a tus datos o su supresión, o hacer cualquier pregunta, abriendo una issue en GitHub. También puedes acudir a la autoridad de protección de datos.',
          ],
        },
        {
          h2: 'Responsable',
          p: ['El sitio lo publica el autor de Mirmalion, localizable en GitHub.'],
        },
      ],
    },
  },
  de: {
    title: 'Mirmalion — Diktat und Transkription, auf deinem Mac',
    description:
      'Diktat, Live-Transkription und Transkription von Audio- oder Videodateien. Alles passiert auf deinem Mac, offline: kein Ton und kein Text verlässt den Rechner.',
    navLabel: 'Abschnitte der Seite',
    langLabel: 'Sprache',
    github: 'Das Mirmalion-Repository auf GitHub, um dem Autor zu schreiben',
    ids: { dictee: 'diktat', direct: 'live', fichiers: 'dateien' },
    nav: { dictee: 'Diktat', direct: 'Live', fichiers: 'Dateien', local: 'Offline' },
    logoAlt: 'Mirmalion-Logo',
    h1: 'Du sprichst, Mirmalion schreibt.',
    lede: 'Diktiere in jeder Anwendung, folge einem Vortrag in einer anderen Sprache mit dem Text live, oder transkribiere eine Datei. Auf deinem Mac, ohne Netz.',
    download: 'Mirmalion herunterladen',
    meta1: 'macOS 26 · Apple Silicon · Kostenlos, offener Code',
    meta2: 'Französisch, Englisch, Spanisch, Deutsch, Italienisch, Portugiesisch.',
    dictee: {
      h2: 'Du sprichst, der Text erscheint genau dort, wo dein Cursor steht.',
      p1a: 'Ein Kurzbefehl, ',
      p1b: ', und du diktierst in jede Anwendung. Der Text wird genau da eingefügt, wo du warst, mit Satzzeichen und sauber.',
      p2a: 'Ein zweiter Kurzbefehl, ',
      p2b: ', schreibt direkt in der Sprache deiner Wahl. Ein persönliches Wörterbuch lernt deine Eigennamen und deine Fachbegriffe.',
      alt: 'Der Bildschirm Diktat in Mirmalion: Diktatmodus, gesprochene Sprache, Übersetzung, Umformulierung.',
    },
    direct: {
      h2: 'Ein Vortrag in einer anderen Sprache, live lesbar.',
      p1: 'Du folgst einem Vortrag auf Englisch, einer Videokonferenz auf Spanisch, einem Video auf Italienisch: Mirmalion greift den Ton deines Macs ab und zeigt den Text nach und nach an, auf Wunsch in deine Sprache übersetzt.',
      p2: 'Am Ende eine Zusammenfassung, auf deinem Rechner von einem lokalen Sprachmodell verfasst, und ein Export des Textes.',
      alt: 'Der Bildschirm Live in Mirmalion: Audioquelle, gesprochene Sprache, Übersetzung und die Schaltfläche Aufnahme starten.',
    },
    fichiers: {
      h2: 'Eine Aufnahme, hineingezogen, transkribiert.',
      p1: 'Lege eine Audio- oder Videodatei ab und erhalte ihren Text. Keine Adresse einzufügen, kein Hochladen: die Datei verlässt deine Festplatte nicht.',
      alt: 'Das Feld Dateien in den Optionen: zieh eine Audio- oder Videodatei hierher oder durchsuche den Computer.',
    },
    local: {
      h2: 'Nichts verlässt deinen Rechner.',
      p1: 'Alle Funktionen arbeiten ohne Netz. Keine Telemetrie, kein Konto, kein Inhalt, der irgendwohin gesendet wird. Das Netz dient nur zwei ausdrücklichen Handgriffen: eine Sprache laden, die App aktualisieren.',
      listLabel: 'Unterstützte Sprachen',
      langs: ['Französisch', 'Englisch', 'Spanisch', 'Deutsch', 'Italienisch', 'Portugiesisch'],
    },
    foot: {
      linksLabel: 'Links',
      source: 'Quellcode',
      releases: 'Alle Versionen',
      license: 'MIT-Lizenz',
      p: 'Mirmalion ist freie Software für macOS 26 auf Apple Silicon.',
    },
    consent: {
      label: 'Besuchszählung',
      text: 'Diese Seite zählt ihre Besuche mit Google Analytics, ohne Werbung. Du kannst ablehnen.',
      more: 'Mehr erfahren',
      yes: 'Akzeptieren',
      no: 'Ablehnen',
    },
    notice: {
      title: 'Datenschutz — Mirmalion',
      link: 'Datenschutz',
      h1: 'Datenschutz',
      date: 'Stand: 11. September 2026.',
      intro:
        'Die App Mirmalion sammelt nichts: Alles passiert auf deinem Mac, ohne Konto und ohne Telemetrie. Diese Seite beschreibt, was die Website mirmalion.web.app tut, und nur das.',
      sections: [
        {
          h2: 'Besuchszählung',
          p: [
            'Mit deiner Einwilligung zählt die Seite ihre Besuche mit Google Analytics, einem Dienst von Google Ireland Limited. Erfasst werden aufgerufene Seiten, das ungefähre Land, Geräte- und Browsertyp und die Herkunft des Besuchs. Werbesignale und Personalisierung sind abgeschaltet.',
            'Ohne deine Einwilligung wird nichts gemessen. Deine Wahl bleibt dreizehn Monate in deinem Browser gespeichert, und der Link „Besuchszählung“ am Ende jeder Seite lässt sie jederzeit ändern. Google bewahrt diese Daten zwei Monate auf.',
          ],
        },
        {
          h2: 'Hosting',
          p: [
            'Die Seite wird von Firebase Hosting, einem Dienst von Google, gehostet. Wie jeder Hoster führt er technische Protokolle, IP-Adresse und aufgerufene Seite, für Sicherheit und Betrieb des Dienstes.',
          ],
        },
        {
          h2: 'Download und GitHub',
          p: [
            'Der Download-Button und der GitHub-Link führen zu github.com, wo dessen eigene Datenschutzerklärung gilt. Wer dem Autor schreiben will, nutzt die Issues des Repositorys: Was du dort veröffentlichst, ist für alle sichtbar.',
          ],
        },
        {
          h2: 'Deine Rechte',
          p: [
            'Du kannst Auskunft über deine Daten oder ihre Löschung verlangen oder jede Frage stellen, indem du ein Issue auf GitHub eröffnest. Du kannst dich auch an eine Datenschutzbehörde wenden.',
          ],
        },
        {
          h2: 'Verantwortlicher',
          p: ['Die Seite wird vom Autor von Mirmalion veröffentlicht, erreichbar auf GitHub.'],
        },
      ],
    },
  },
  it: {
    title: 'Mirmalion — dettatura e trascrizione, sul tuo Mac',
    description:
      'Dettatura, trascrizione in diretta e trascrizione di file audio o video. Tutto avviene sul tuo Mac, offline: nessun suono, nessun testo esce dalla macchina.',
    navLabel: 'Sezioni della pagina',
    langLabel: 'Lingua',
    github: "Il repository di Mirmalion su GitHub, per scrivere all'autore",
    ids: { dictee: 'dettatura', direct: 'diretta', fichiers: 'file' },
    nav: { dictee: 'Dettatura', direct: 'Diretta', fichiers: 'File', local: 'Offline' },
    logoAlt: 'Logo di Mirmalion',
    h1: 'Tu parli, Mirmalion scrive.',
    lede: "Detta in qualsiasi applicazione, segui una conferenza in un'altra lingua con il testo in diretta, o trascrivi un file. Sul tuo Mac, senza rete.",
    download: 'Scarica Mirmalion',
    meta1: 'macOS 26 · Apple Silicon · Gratuito, codice aperto',
    meta2: 'Francese, inglese, spagnolo, tedesco, italiano, portoghese.',
    dictee: {
      h2: "Tu parli, il testo si scrive proprio dov'è il cursore.",
      p1a: 'Una scorciatoia, ',
      p1b: ', e detti in qualsiasi applicazione. Il testo si inserisce nel punto esatto in cui eri, punteggiato e pulito.',
      p2a: 'Una seconda scorciatoia, ',
      p2b: ', scrive direttamente nella lingua che scegli. Un dizionario personale impara i tuoi nomi propri e i termini del tuo mestiere.',
      alt: 'La schermata Dettatura di Mirmalion: modalità di dettatura, lingua parlata, traduzione, riformulazione.',
    },
    direct: {
      h2: "Una conferenza in un'altra lingua, leggibile in diretta.",
      p1: "Segui una conferenza in inglese, una videochiamata in spagnolo, un video in tedesco: Mirmalion cattura l'audio del tuo Mac e mostra il testo man mano, tradotto nella tua lingua se lo desideri.",
      p2: "Alla fine, un riepilogo scritto sulla tua macchina da un modello linguistico locale, e un'esportazione del testo.",
      alt: 'La schermata Diretta di Mirmalion: sorgente audio, lingua parlata, traduzione e il pulsante Avvia la registrazione.',
    },
    fichiers: {
      h2: 'Una registrazione, trascinata, trascritta.',
      p1: 'Trascina un file audio o video e ottieni il suo testo. Nessun indirizzo da incollare, nessun invio: il file non lascia il tuo disco.',
      alt: 'Il pannello File delle Opzioni: trascina un file audio o video, o sfoglia il computer.',
    },
    local: {
      h2: 'Niente esce dalla tua macchina.',
      p1: "Tutte le funzioni lavorano senza rete. Nessuna telemetria, nessun account, nessun contenuto inviato da nessuna parte. La rete serve solo a due gesti espliciti: scaricare una lingua, aggiornare l'applicazione.",
      listLabel: 'Lingue supportate',
      langs: ['Francese', 'Inglese', 'Spagnolo', 'Tedesco', 'Italiano', 'Portoghese'],
    },
    foot: {
      linksLabel: 'Collegamenti',
      source: 'Codice sorgente',
      releases: 'Tutte le versioni',
      license: 'Licenza MIT',
      p: 'Mirmalion è software libero per macOS 26 su Apple Silicon.',
    },
    consent: {
      label: 'Statistiche di visita',
      text: 'Questo sito conta le visite con Google Analytics, senza pubblicità. Puoi rifiutare.',
      more: 'Maggiori informazioni',
      yes: 'Accetta',
      no: 'Rifiuta',
    },
    notice: {
      title: 'Privacy — Mirmalion',
      link: 'Privacy',
      h1: 'Privacy',
      date: "Aggiornata l'11 settembre 2026.",
      intro:
        "L'applicazione Mirmalion non raccoglie nulla: tutto avviene sul tuo Mac, senza account né telemetria. Questa pagina descrive cosa fa il sito mirmalion.web.app, e solo quello.",
      sections: [
        {
          h2: 'Statistiche di visita',
          p: [
            'Con il tuo consenso, il sito conta le visite con Google Analytics, un servizio di Google Ireland Limited. Registra le pagine viste, il paese approssimativo, il tipo di dispositivo e di browser, e la provenienza della visita. I segnali pubblicitari e la personalizzazione sono disattivati.',
            'Senza il tuo consenso, non viene misurato nulla. La tua scelta resta tredici mesi nel tuo browser, e il collegamento « Statistiche di visita » in fondo a ogni pagina permette di cambiarla in qualsiasi momento. Google conserva questi dati per due mesi.',
          ],
        },
        {
          h2: 'Hosting',
          p: [
            'Il sito è ospitato su Firebase Hosting, un servizio di Google. Come ogni host, tiene registri tecnici, indirizzo IP e pagina richiesta, per la sicurezza e il funzionamento del servizio.',
          ],
        },
        {
          h2: 'Download e GitHub',
          p: [
            "Il pulsante di download e il collegamento a GitHub portano su github.com, che applica la propria informativa sulla privacy. Per scrivere all'autore si usano le issue del repository: ciò che pubblichi lì è visibile a tutti.",
          ],
        },
        {
          h2: 'I tuoi diritti',
          p: [
            "Puoi chiedere l'accesso ai tuoi dati o la loro cancellazione, o porre qualsiasi domanda, aprendo una issue su GitHub. Puoi anche rivolgerti al Garante per la protezione dei dati.",
          ],
        },
        {
          h2: 'Titolare',
          p: ["Il sito è pubblicato dall'autore di Mirmalion, raggiungibile su GitHub."],
        },
      ],
    },
  },
  pt: {
    title: 'Mirmalion — ditado e transcrição, no teu Mac',
    description:
      'Ditado, transcrição em direto e transcrição de ficheiros de áudio ou vídeo. Tudo acontece no teu Mac, sem ligação: nenhum som, nenhum texto sai da máquina.',
    navLabel: 'Secções da página',
    langLabel: 'Idioma',
    github: 'O repositório do Mirmalion no GitHub, para escrever ao autor',
    ids: { dictee: 'ditado', direct: 'direto', fichiers: 'ficheiros' },
    nav: { dictee: 'Ditado', direct: 'Direto', fichiers: 'Ficheiros', local: 'Sem ligação' },
    logoAlt: 'Logótipo do Mirmalion',
    h1: 'Tu falas, o Mirmalion escreve.',
    lede: 'Dita em qualquer aplicação, acompanha uma conferência noutra língua com o texto em direto, ou transcreve um ficheiro. No teu Mac, sem rede.',
    download: 'Descarregar Mirmalion',
    meta1: 'macOS 26 · Apple Silicon · Gratuito, código aberto',
    meta2: 'Francês, inglês, espanhol, alemão, italiano, português.',
    dictee: {
      h2: 'Tu falas, o texto escreve-se exatamente onde está o cursor.',
      p1a: 'Um atalho, ',
      p1b: ', e ditas em qualquer aplicação. O texto insere-se no ponto exato onde estavas, pontuado e limpo.',
      p2a: 'Um segundo atalho, ',
      p2b: ', escreve diretamente na língua que escolheres. Um dicionário pessoal aprende os teus nomes próprios e os termos da tua profissão.',
      alt: 'O ecrã Ditado do Mirmalion: modo de ditado, idioma falado, tradução, reformulação.',
    },
    direct: {
      h2: 'Uma conferência noutra língua, legível em direto.',
      p1: 'Acompanhas uma conferência em inglês, uma videochamada em espanhol, um vídeo em alemão: o Mirmalion capta o som do teu Mac e mostra o texto à medida que avança, traduzido para a tua língua se quiseres.',
      p2: 'No fim, um resumo redigido na tua máquina por um modelo de linguagem local, e uma exportação do texto.',
      alt: 'O ecrã Direto do Mirmalion: fonte de áudio, idioma falado, tradução e o botão Começar a gravar.',
    },
    fichiers: {
      h2: 'Uma gravação, arrastada, transcrita.',
      p1: 'Larga um ficheiro de áudio ou vídeo e recupera o seu texto. Nenhum endereço a colar, nenhum envio: o ficheiro não sai do teu disco.',
      alt: 'O painel Ficheiros das Opções: arrasta um ficheiro de áudio ou vídeo, ou procura no computador.',
    },
    local: {
      h2: 'Nada sai da tua máquina.',
      p1: 'Todas as funções trabalham sem rede. Sem telemetria, sem conta, sem conteúdo enviado para lado nenhum. A rede só serve para dois gestos explícitos: descarregar um idioma, atualizar a aplicação.',
      listLabel: 'Idiomas suportados',
      langs: ['Francês', 'Inglês', 'Espanhol', 'Alemão', 'Italiano', 'Português'],
    },
    foot: {
      linksLabel: 'Ligações',
      source: 'Código-fonte',
      releases: 'Todas as versões',
      license: 'Licença MIT',
      p: 'O Mirmalion é software livre para macOS 26 em Apple Silicon.',
    },
    consent: {
      label: 'Medição de audiência',
      text: 'Este site conta as visitas com o Google Analytics, sem publicidade. Podes recusar.',
      more: 'Saber mais',
      yes: 'Aceitar',
      no: 'Recusar',
    },
    notice: {
      title: 'Privacidade — Mirmalion',
      link: 'Privacidade',
      h1: 'Privacidade',
      date: 'Atualizada a 11 de setembro de 2026.',
      intro:
        'A aplicação Mirmalion não recolhe nada: tudo acontece no teu Mac, sem conta nem telemetria. Esta página descreve o que faz o site mirmalion.web.app, e só ele.',
      sections: [
        {
          h2: 'Medição de audiência',
          p: [
            'Com o teu consentimento, o site conta as visitas com o Google Analytics, um serviço da Google Ireland Limited. Regista as páginas vistas, o país aproximado, o tipo de dispositivo e de navegador, e a origem da visita. Os sinais publicitários e a personalização estão desativados.',
            'Sem o teu consentimento, nada é medido. A tua escolha fica guardada treze meses no teu navegador, e a ligação « Medição de audiência » no fim de cada página permite mudá-la a qualquer momento. A Google conserva estes dados durante dois meses.',
          ],
        },
        {
          h2: 'Alojamento',
          p: [
            'O site está alojado no Firebase Hosting, um serviço da Google. Como qualquer alojamento, mantém registos técnicos, endereço IP e página pedida, para a segurança e o funcionamento do serviço.',
          ],
        },
        {
          h2: 'Descarga e GitHub',
          p: [
            'O botão de descarga e a ligação ao GitHub levam a github.com, que aplica a sua própria política de privacidade. Escrever ao autor passa pelas issues do repositório: o que lá publicares é visível para todos.',
          ],
        },
        {
          h2: 'Os teus direitos',
          p: [
            'Podes pedir acesso aos teus dados ou a sua eliminação, ou colocar qualquer questão, abrindo uma issue no GitHub. Podes também recorrer à autoridade de proteção de dados.',
          ],
        },
        {
          h2: 'Responsável',
          p: ['O site é publicado pelo autor do Mirmalion, contactável no GitHub.'],
        },
      ],
    },
  },
};

/** Le chemin d'une page depuis la racine du site, dossier terminé par `/`, vide pour l'accueil. */
function homePath(code) {
  return code === 'fr' ? '' : `${code}/`;
}

function noticePath(code) {
  return `${homePath(code)}${NOTICE_SLUG[code]}/`;
}

/** Le préfixe qui remonte d'une page à la racine du site. */
function toRoot(path) {
  return '../'.repeat(path.split('/').length - 1);
}

const GITHUB_MARK =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z';

/** Le script de l'accueil français : sert la page de la langue du navigateur, sauf choix mémorisé. */
const REDIRECT = `
    <script>
      // Sert la page de la langue du navigateur, sauf choix explicite mémorisé par le menu de
      // langue. La racine reste le français ; les autres langues vivent sous leur code.
      (function () {
        try {
          var codes = ['fr', 'en', 'es', 'de', 'it', 'pt'];
          var choice = localStorage.getItem('mirmalion-lang');
          if (choice === 'fr') return;
          var wanted = codes.indexOf(choice) > 0 ? choice : '';
          var spoken = navigator.languages || [navigator.language || ''];
          for (var i = 0; i < spoken.length && !wanted; i++) {
            var code = String(spoken[i]).slice(0, 2).toLowerCase();
            if (codes.indexOf(code) >= 0) wanted = code;
          }
          if (!wanted && spoken.join('')) wanted = 'en';
          if (wanted && wanted !== 'fr') {
            // ⚠️ Lu par la mesure d'audience : une visite qui repart aussitôt ne se compte pas ici.
            window.mirmalionLeaving = true;
            location.replace(wanted + '/');
          }
        } catch (e) {
          return;
        }
      })();
    </script>`;

/** Le menu de langue se referme d’un clic ailleurs ou par Échap : un `<details>` seul reste ouvert. */
const LANG_MENU = `
    <script>
      document.addEventListener('click', function (event) {
        var menu = document.querySelector('.lang[open]');
        if (menu && !menu.contains(event.target)) menu.removeAttribute('open');
      });
      document.addEventListener('keydown', function (event) {
        var menu = document.querySelector('.lang[open]');
        if (event.key === 'Escape' && menu) menu.removeAttribute('open');
      });
    </script>`;

/**
 * Le bandeau de consentement et la mesure d'audience, qui ne se charge qu'après « Accepter ».
 *
 * Le choix vaut treize mois, la durée maximale admise par la CNIL, puis la question revient.
 */
function consent(code, path) {
  const c = T[code].consent;
  return `
    <aside id="consent" class="consent" hidden aria-label="${c.label}">
      <p>${c.text} <a href="${toRoot(path)}${noticePath(code)}">${c.more}</a></p>
      <button type="button" data-consent="yes">${c.yes}</button>
      <button type="button" data-consent="no">${c.no}</button>
    </aside>
    <script>
      (function () {
        if (window.mirmalionLeaving) return;
        var KEY = 'mirmalion-consent';
        var VALID_MS = 13 * 30 * 24 * 60 * 60 * 1000;
        var banner = document.getElementById('consent');
        function measure() {
          if (window.gtag) return;
          window.dataLayer = window.dataLayer || [];
          window.gtag = function () {
            dataLayer.push(arguments);
          };
          gtag('js', new Date());
          gtag('config', '${MEASUREMENT_ID}', {
            allow_google_signals: false,
            allow_ad_personalization_signals: false,
          });
          var tag = document.createElement('script');
          tag.async = true;
          tag.src = 'https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}';
          document.head.appendChild(tag);
        }
        function read() {
          try {
            var parts = (localStorage.getItem(KEY) || '').split(':');
            var age = Date.now() - Number(parts[1]);
            return age >= 0 && age < VALID_MS ? parts[0] : null;
          } catch (e) {
            return null;
          }
        }
        function write(value) {
          try {
            localStorage.setItem(KEY, value + ':' + Date.now());
          } catch (e) {
            return;
          }
        }
        banner.addEventListener('click', function (event) {
          var button = event.target.closest('[data-consent]');
          if (!button) return;
          var value = button.getAttribute('data-consent');
          write(value);
          banner.hidden = true;
          if (value === 'yes') measure();
        });
        document.querySelector('a[href="#consent"]').addEventListener('click', function (event) {
          event.preventDefault();
          banner.hidden = false;
        });
        var choice = read();
        if (choice === 'yes') measure();
        else if (choice !== 'no') banner.hidden = false;
      })();
    </script>`;
}

function head(code, path, { title, description, pathOf }) {
  const p = toRoot(path);
  const alternates = CODES.map(
    (c) => `    <link rel="alternate" hreflang="${c}" href="${SITE}${pathOf(c)}" />`,
  ).join('\n');
  return `  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
${alternates}
    <link rel="alternate" hreflang="x-default" href="${SITE}${pathOf('fr')}" />
    <link rel="icon" href="${p}img/favicon.png" type="image/png" />
    <link rel="apple-touch-icon" href="${p}img/apple-touch-icon.png" />${path === '' ? REDIRECT : ''}
    <link rel="stylesheet" href="${p}landing.css?v=4" />
  </head>`;
}

function logo(p, cls, alt, w, h) {
  return `<picture>
          <source srcset="${p}img/logo-mark-magenta.png" media="(prefers-color-scheme: dark)" />
          <img${cls ? ` class="${cls}"` : ''} src="${p}img/logo-mark.png" alt="${alt}" width="${w}" height="${h}" />
        </picture>`;
}

/** L'en-tête : la marque, les ancres de l'accueil (ou rien), le lien GitHub et le menu de langue. */
function header(code, path, { nav, pathOf }) {
  const t = T[code];
  const p = toRoot(path);
  const langLinks = CODES.filter((c) => c !== code)
    .map(
      (c) =>
        `          <li><a href="${p}${pathOf(c)}" lang="${c}" hreflang="${c}" onclick="try { localStorage.setItem('mirmalion-lang', '${c}'); } catch (e) { return; }">${NATIVE[c]}</a></li>`,
    )
    .join('\n');
  return `    <header class="top${nav ? '' : ' top--plain'}">
      <a class="brand" href="${p || '#top'}">
        ${logo(p, '', '', 44, 21)}
        Mirmalion
      </a>
${nav ?? ''}
      <div class="top__tools">
        <a class="github" href="${REPO}" aria-label="${t.github}">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${GITHUB_MARK}" /></svg>
        </a>
        <details class="lang">
          <summary aria-label="${t.langLabel}">${NATIVE[code]}</summary>
          <ul role="list">
${langLinks}
          </ul>
        </details>
      </div>
    </header>`;
}

function footer(code, path) {
  const t = T[code];
  const p = toRoot(path);
  return `    <footer class="foot">
      <a class="download" href="${p || '#top'}">${t.download}</a>
      <nav aria-label="${t.foot.linksLabel}">
        <a href="${REPO}">${t.foot.source}</a>
        <a href="${REPO}/releases">${t.foot.releases}</a>
        <a href="${REPO}/blob/main/LICENSE">${t.foot.license}</a>
        <a href="${p}${noticePath(code)}">${t.notice.link}</a>
        <a href="#consent">${t.consent.label}</a>
      </nav>
      <p>${t.foot.p}</p>
    </footer>`;
}

function home(code) {
  const t = T[code];
  const path = homePath(code);
  const p = toRoot(path);
  const shot = (name) => `${p}img/${name}${code === 'fr' ? '' : `-${code}`}.png?v=3`;
  const kbd2 = '<kbd>⌃</kbd><kbd>⌥</kbd>';
  const kbd3 = '<kbd>⌃</kbd><kbd>⌥</kbd><kbd>⌘</kbd>';
  const { dictee, direct, fichiers } = t.ids;
  const nav = `      <nav aria-label="${t.navLabel}">
        <a href="#${dictee}">${t.nav.dictee}</a>
        <a href="#${direct}">${t.nav.direct}</a>
        <a href="#${fichiers}">${t.nav.fichiers}</a>
        <a href="#local">${t.nav.local}</a>
      </nav>`;
  return `<!doctype html>
<html lang="${code}">
${head(code, path, { title: t.title, description: t.description, pathOf: homePath })}
  <body>
${header(code, path, { nav, pathOf: homePath })}

    <main id="top">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero__text">
          ${logo(p, 'logo', t.logoAlt, 168, 80)}
          <h1 id="hero-title">${t.h1}</h1>
          <p class="lede">${t.lede}</p>
          <a class="download" data-download href="${DMG}">
            ${t.download} <span data-version>${VERSION}</span>
          </a>
          <div class="meta">
            <p>${t.meta1}</p>
            <p>${t.meta2}</p>
          </div>
        </div>
        <div class="hero__shots" aria-hidden="true">
          <figure class="feature__shot">
            <div class="win">
              <img src="${shot('dictee')}" alt="" width="900" height="1270" />
            </div>
          </figure>
          <figure class="feature__shot">
            <div class="win">
              <img src="${shot('direct')}" alt="" width="900" height="1270" />
            </div>
          </figure>
        </div>
      </section>

      <section id="${dictee}" class="feature feature--tall feature--reverse" aria-labelledby="${dictee}-title">
        <div class="feature__text">
          <p class="eyebrow">${t.nav.dictee}</p>
          <h2 id="${dictee}-title">${t.dictee.h2}</h2>
          <p>${t.dictee.p1a}${kbd2}${t.dictee.p1b}</p>
          <p>${t.dictee.p2a}${kbd3}${t.dictee.p2b}</p>
        </div>
        <figure class="feature__shot">
          <div class="win">
            <img src="${shot('dictee')}" alt="${t.dictee.alt}" width="900" height="1270" />
          </div>
        </figure>
      </section>

      <section id="${direct}" class="feature feature--tall" aria-labelledby="${direct}-title">
        <div class="feature__text">
          <p class="eyebrow">${t.nav.direct}</p>
          <h2 id="${direct}-title">${t.direct.h2}</h2>
          <p>${t.direct.p1}</p>
          <p>${t.direct.p2}</p>
        </div>
        <figure class="feature__shot">
          <div class="win">
            <img src="${shot('direct')}" alt="${t.direct.alt}" width="900" height="1270" loading="lazy" />
          </div>
        </figure>
      </section>

      <section id="${fichiers}" class="feature feature--reverse" aria-labelledby="${fichiers}-title">
        <div class="feature__text">
          <p class="eyebrow">${t.nav.fichiers}</p>
          <h2 id="${fichiers}-title">${t.fichiers.h2}</h2>
          <p>${t.fichiers.p1}</p>
        </div>
        <figure class="feature__shot">
          <div class="win">
            <img src="${shot('fichiers')}" alt="${t.fichiers.alt}" width="1800" height="1270" loading="lazy" />
          </div>
        </figure>
      </section>

      <section id="local" class="local" aria-labelledby="local-title">
        <h2 id="local-title">${t.local.h2}</h2>
        <p>${t.local.p1}</p>
        <ul role="list" aria-label="${t.local.listLabel}">
${t.local.langs.map((l) => `          <li>${l}</li>`).join('\n')}
        </ul>
      </section>
    </main>

${footer(code, path)}
${LANG_MENU}${consent(code, path)}
  </body>
</html>
`;
}

function notice(code) {
  const t = T[code];
  const n = t.notice;
  const path = noticePath(code);
  const sections = n.sections
    .map(
      (s) => `      <h2>${s.h2}</h2>
${s.p.map((p) => `      <p>${p}</p>`).join('\n')}`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="${code}">
${head(code, path, { title: n.title, description: n.intro, pathOf: noticePath })}
  <body>
${header(code, path, { nav: null, pathOf: noticePath })}

    <main id="top" class="notice">
      <h1>${n.h1}</h1>
      <p class="notice__date">${n.date}</p>
      <p>${n.intro}</p>
${sections}
    </main>

${footer(code, path)}
${LANG_MENU}${consent(code, path)}
  </body>
</html>
`;
}

for (const code of CODES) {
  for (const [path, html] of [
    [homePath(code), home(code)],
    [noticePath(code), notice(code)],
  ]) {
    const dir = `landing/${path}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}index.html`, html);
    process.stdout.write(`${dir}index.html\n`);
  }
}
