import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { applyWindowRoute } from './app/app.routes';
import { App } from './app/app';

// ⚠️ Avant le bootstrap, pas après : l'URL de départ dépend de la fenêtre dans laquelle on
// démarre, et la poser une fois Angular lancé ferait résoudre `/` d'abord — une fenêtre
// secondaire montrerait un éclair de l'écran principal. Voir `applyWindowRoute`.
applyWindowRoute()
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
