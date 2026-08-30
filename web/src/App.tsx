import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router-dom';
import { authStore } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';
import { LandingPage } from '@/pages/landing';
import { LoginPage } from '@/pages/login';
import { OverviewPage } from '@/pages/overview';
import { TargetsPage } from '@/pages/targets';
import { IncidentsPage } from '@/pages/incidents';
import { SchedulerPage } from '@/pages/scheduler';
import { AlertsPage } from '@/pages/alerts';
import { ApprovalsPage } from '@/pages/approvals';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

function RequireAuth() {
  return authStore.isAuthed() ? <Outlet /> : <Navigate to="/login" replace />;
}

const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        path: '/app',
        element: <AppShell />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'targets', element: <TargetsPage /> },
          { path: 'incidents', element: <IncidentsPage /> },
          { path: 'scheduler', element: <SchedulerPage /> },
          { path: 'alerts', element: <AlertsPage /> },
          { path: 'approvals', element: <ApprovalsPage /> },
        ],
      },
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
