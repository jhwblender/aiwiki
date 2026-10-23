import { indexMissingDocuments } from './lib/docsearch';
import { kick } from './lib/queue';
import { startWatching } from './lib/watcher';
import { startLibrarian } from './lib/librarianAuto';

// Make every stored document searchable, resume background filing, start checking watched folders,
// and let the librarian tidy on its own
indexMissingDocuments();
kick();
startWatching();
startLibrarian();
