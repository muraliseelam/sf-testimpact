/**
 * Quoting for the one place the tool spawns a process through a shell.
 *
 * On Windows `sf` is `sf.cmd`, which Node can only start through `cmd.exe`, and a shell
 * concatenates the argument vector with spaces. Unquoted, a path such as
 * `force-app/main/default/classes/Collection Recipes/X.cls` arrives as two arguments. The
 * first live `deploy` on Windows failed exactly that way ("force-app/main/default/classes/
 * Collection: File or folder not found"); apex-recipes keeps its classes in directories with
 * spaces in their names, and so do many real projects.
 */

/** Characters that need the argument wrapped in double quotes for `cmd.exe`. */
const NEEDS_QUOTING = /[\s"&|<>^()]/;

/**
 * Quote one argument for `cmd.exe` when it needs it; return it unchanged otherwise.
 *
 * Inside double quotes `cmd.exe` takes `""` as a literal quote. Nothing else is escaped:
 * the arguments this reaches are file paths, metadata names and flags, and the only
 * characters they realistically carry are spaces and parentheses.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!NEEDS_QUOTING.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Quote every argument when the spawn goes through a shell; leave them alone otherwise. */
export function argsForSpawn(args: readonly string[], useShell: boolean): string[] {
  return useShell ? args.map(quoteForCmd) : [...args];
}
