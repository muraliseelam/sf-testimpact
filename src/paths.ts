/**
 * Path joining for project-relative files.
 *
 * Everything in the graph is keyed by a repository-relative path, so `.` as a root must not
 * produce `./force-app/...` for one caller and `force-app/...` for another — two spellings
 * of the same file would be two entries in the index.
 */

/** Join a project root and a relative path, normalising a `.` or empty root away. */
export function joinPath(root: string, relative: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base === '' || base === '.') return relative;
  return `${base}/${relative}`;
}
