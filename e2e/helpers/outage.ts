/**
 * The Postgres container the database outage spec stops and starts (NFR-AVL-04): the slot's `v060-pg-bK`, or in
 * CI the service container, which the CI step names with `docker ps -q --filter ancestor=postgres:16-alpine`.
 *
 * Outside CI the variable is optional and an unset or empty one skips the spec (`null`, the spec prints why).
 * In CI an empty one is a failure: the filter matched no container, and a skip there would turn the step green
 * without having tested anything. The name goes to the docker CLI as an argument, so it must be a container
 * name or id and never an option, a path or a second word.
 */
export function outageContainer(env: NodeJS.ProcessEnv): string | null {
  const name = env.E2E_DB_CONTAINER ?? '';
  if (name === '') {
    if (env.CI) throw new Error('E2E_DB_CONTAINER is empty in CI: the docker ps filter matched no Postgres container');
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('E2E_DB_CONTAINER is not a container name or id');
  return name;
}
