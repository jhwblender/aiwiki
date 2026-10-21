import { kick } from './lib/queue';
import { startWatching } from './lib/watcher';

// Resume background filing and start checking watched folders
kick();
startWatching();
