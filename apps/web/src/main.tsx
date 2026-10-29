import './zod-config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ApiRequestError } from './api';
import './index.css';
import { Layout } from './layout';
import Audit from './pages/Audit';
import Login from './pages/Login';
import Logs from './pages/Logs';
import NotImplemented from './pages/NotImplemented';
import Overview from './pages/Overview';
import ProjectDetail from './pages/ProjectDetail';
import Projects from './pages/Projects';
import SourceWizard from './pages/SourceWizard';
import TraceDetailPage from './pages/TraceDetail';
import Traces from './pages/Traces';
import Metrics from './pages/Metrics';
import ServiceDetail from './pages/ServiceDetail';
import Services from './pages/Services';
import Settings from './pages/Settings';
import Sources from './pages/Sources';
import { SelectionProvider, SessionGate } from './session';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Never retry auth/permission/not-found failures; they will not fix themselves.
      retry: (n, e) => !(e instanceof ApiRequestError && e.status < 500) && n < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionGate login={<Login />}>
          <SelectionProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Overview />} />
                <Route path="projects" element={<Projects />} />
                <Route path="projects/:projectId" element={<ProjectDetail />} />
                <Route path="logs" element={<Logs />} />
                <Route path="sources" element={<Sources />} />
                <Route path="sources/new" element={<SourceWizard />} />
                <Route path="traces" element={<Traces />} />
                <Route path="traces/:traceId" element={<TraceDetailPage />} />
                <Route path="services" element={<Services />} />
                <Route path="services/:service" element={<ServiceDetail />} />
                <Route path="metrics" element={<Metrics />} />
                <Route path="audit" element={<Audit />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<NotImplemented />} />
              </Route>
            </Routes>
          </SelectionProvider>
        </SessionGate>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
