export const XAML_WORKSPACE_INCLUDE_GLOB = "**/*.xaml";
export const XAML_WORKSPACE_EXCLUDE_GLOB =
  "**/{bin,obj,node_modules,packages,.git,.nuget}/**";
export const XAML_WORKSPACE_MAX_RESULTS = 1;

export async function findFirstWorkspaceXaml<T>(
  findFiles: (
    include: string,
    exclude: string,
    maxResults: number
  ) => PromiseLike<readonly T[]>
): Promise<T | undefined> {
  const matches = await findFiles(
    XAML_WORKSPACE_INCLUDE_GLOB,
    XAML_WORKSPACE_EXCLUDE_GLOB,
    XAML_WORKSPACE_MAX_RESULTS
  );
  return matches[0];
}
