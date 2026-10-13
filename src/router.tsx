import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Data is refreshed by the ingestion pipeline, not per-second — keep
        // results warm so navigating back to a page is instant instead of
        // refiring every request.
        staleTime: 5 * 60_000,
        gcTime: 30 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnMount: true,
        refetchInterval: 5 * 60_000,
        refetchIntervalInBackground: false,
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 5 * 60_000,
  });

  return router;
};
