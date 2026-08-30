import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from '@/components/app-shell';
import { LandingPage } from '@/pages/landing';
import { OverviewPage } from '@/pages/overview';
import { TargetsPage } from '@/pages/targets';
import { IncidentsPage } from '@/pages/incidents';
import { SchedulerPage } from '@/pages/scheduler';
import { AlertsPage } from '@/pages/alerts';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  {
    path: '/app',
    element: <AppShell />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'targets', element: <TargetsPage /> },
      { path: 'incidents', element: <IncidentsPage /> },
      { path: 'scheduler', element: <SchedulerPage /> },
      { path: 'alerts', element: <AlertsPage /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
