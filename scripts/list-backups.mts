// Lists what's in the backup bucket.  railway run npx tsx scripts/list-backups.mts
import { listObjects } from "../src/lib/s3";
const keys = await listObjects("");
console.log(keys.length ? keys.join("\n") : "(bucket is empty)");
