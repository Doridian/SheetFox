/** npm run index – regenerate library/index.json (runs automatically before dev and build) */
import { rebuildIndex } from "./library";

const entries = rebuildIndex();
console.log(`library/index.json: ${entries.length} sheets`);
