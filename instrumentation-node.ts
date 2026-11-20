import { indexMissingDocuments } from './lib/docsearch';
import { kick } from './lib/queue';
import { startWatching } from './lib/watcher';
import { startLibrarian } from './lib/librarianAuto';
import { writeOpsToken } from './lib/opsToken';

// Make every stored document searchable, resume background filing, start checking watched folders,
// let the librarian tidy on its own, and leave the update script its secret
indexMissingDocuments();
kick();
startWatching();
startLibrarian();
writeOpsToken();
