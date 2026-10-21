import { indexMissingDocuments } from './lib/docsearch';
import { kick } from './lib/queue';
import { startWatching } from './lib/watcher';

// Make every stored document searchable, resume background filing and start checking watched folders
indexMissingDocuments();
kick();
startWatching();
