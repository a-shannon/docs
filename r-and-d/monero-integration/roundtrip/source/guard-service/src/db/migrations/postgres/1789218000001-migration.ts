import { Migration1789218000000 } from '../sqlite/1789218000000-migration';

/** Same portable schema; PostgreSQL execution requires its own qualification. */
export class Migration1789218000001 extends Migration1789218000000 {
  name = 'Migration1789218000001';
}
