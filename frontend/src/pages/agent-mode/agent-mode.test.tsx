import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createFlow: vi.fn(),
    createFlowWithAssistant: vi.fn(),
    flows: [] as Array<Record<string, unknown>>,
    providers: [] as Array<{ name: string; type: string }>,
    selectedProvider: null as null | { name: string; type: string },
    setSelectedProvider: vi.fn(),
}));

vi.mock('@/components/layouts/app/app-header', () => {
    const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

    return { AppHeader: Pass, AppHeaderContent: Pass, AppHeaderTitle: Pass };
});

vi.mock('@/providers/flows-provider', () => ({
    useFlows: () => ({ createFlow: mocks.createFlow, createFlowWithAssistant: mocks.createFlowWithAssistant }),
}));

vi.mock('@/providers/providers-provider', () => ({
    useProviders: () => ({
        providers: mocks.providers,
        selectedProvider: mocks.selectedProvider,
        setSelectedProvider: mocks.setSelectedProvider,
    }),
}));

vi.mock('@/providers/sidebar-flows-provider', () => ({
    useSidebarFlows: () => ({ flows: mocks.flows }),
}));

vi.mock('@/providers/system-settings-provider', () => ({
    useSystemSettings: () => ({ settings: { assistantUseAgents: false } }),
}));

vi.mock('@/providers/templates-provider', () => ({
    useTemplates: () => ({ templates: [] }),
}));

vi.mock('@/providers/resources-provider', () => ({
    useResources: () => ({ resources: [] }),
}));

vi.mock('@/features/resources/use-resources-upload', () => ({
    useResourcesUpload: () => ({ isUploading: false, uploadFiles: vi.fn() }),
}));

const { default: AgentMode } = await import('./agent-mode');

function FlowProbe() {
    const location = useLocation();

    return <p>flow page {`${location.pathname}${location.search}`}</p>;
}

const renderPage = () =>
    render(
        <MemoryRouter initialEntries={['/agent-mode']}>
            <Routes>
                <Route
                    element={<AgentMode />}
                    path="/agent-mode"
                />
                <Route
                    element={<FlowProbe />}
                    path="/flows/:flowId"
                />
            </Routes>
        </MemoryRouter>,
    );

const submitTask = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.type(screen.getByRole('textbox'), text);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
};

beforeEach(() => {
    mocks.createFlow.mockReset();
    mocks.createFlowWithAssistant.mockReset();
    mocks.setSelectedProvider.mockReset();
    mocks.providers = [
        { name: 'claude-cli', type: 'custom' },
        { name: 'openai', type: 'openai' },
        { name: 'OpenCode', type: 'custom' },
    ];
    mocks.selectedProvider = { name: 'openai', type: 'openai' };
    mocks.flows = [];
});

describe('AgentMode', () => {
    it('lists only the custom CLI providers and selects OpenCode by default', () => {
        renderPage();

        const group = screen.getByRole('radiogroup', { name: 'CLI agent providers' });
        const cards = within(group).getAllByRole('radio');

        expect(cards.map((card) => card.textContent)).toEqual([
            expect.stringContaining('claude-cli'),
            expect.stringContaining('OpenCode'),
        ]);
        expect(within(group).getByRole('radio', { name: /OpenCode/ })).toHaveAttribute('aria-checked', 'true');
        expect(within(group).getByRole('radio', { name: /claude-cli/ })).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText('Runs on OpenCode')).toBeInTheDocument();
    });

    it('falls back to every provider when none is custom', () => {
        mocks.providers = [{ name: 'openai', type: 'openai' }];
        renderPage();

        expect(screen.getByRole('radio', { name: /openai/ })).toHaveAttribute('aria-checked', 'true');
    });

    it('links to provider management', () => {
        renderPage();

        expect(screen.getByRole('link', { name: 'Manage providers' })).toHaveAttribute('href', '/settings/providers');
    });

    it('switches provider on card click and submits the flow with it', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlow.mockResolvedValue('7');
        renderPage();

        await user.click(screen.getByRole('radio', { name: /claude-cli/ }));

        expect(mocks.setSelectedProvider).toHaveBeenCalledWith({ name: 'claude-cli', type: 'custom' });
        expect(screen.getByRole('radio', { name: /claude-cli/ })).toHaveAttribute('aria-checked', 'true');

        await submitTask(user, 'scan 10.0.0.5');

        await waitFor(() => expect(mocks.createFlow).toHaveBeenCalledOnce());
        expect(mocks.createFlow.mock.calls[0]?.[0]).toMatchObject({
            message: 'scan 10.0.0.5',
            providerName: 'claude-cli',
        });
    });

    it('launches an automation flow on OpenCode and opens it', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlow.mockResolvedValue('42');
        renderPage();

        await submitTask(user, 'scan 10.0.0.5');

        expect(await screen.findByText('flow page /flows/42?tab=automation')).toBeInTheDocument();
        expect(mocks.createFlow.mock.calls[0]?.[0]).toMatchObject({ providerName: 'OpenCode' });
        expect(mocks.createFlowWithAssistant).not.toHaveBeenCalled();
    });

    it('launches an assistant flow from the Assistant tab', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlowWithAssistant.mockResolvedValue('43');
        renderPage();

        await user.click(screen.getByRole('tab', { name: 'Assistant' }));
        await submitTask(user, 'help me enumerate');

        expect(await screen.findByText('flow page /flows/43?tab=assistant')).toBeInTheDocument();
        expect(mocks.createFlowWithAssistant.mock.calls[0]?.[0]).toMatchObject({ providerName: 'OpenCode' });
        expect(mocks.createFlow).not.toHaveBeenCalled();
    });

    it('shows recent flows run on CLI providers only, newest first', () => {
        mocks.flows = [
            {
                createdAt: '2026-11-20T10:00:00Z',
                id: '1',
                provider: { name: 'OpenCode', type: 'custom' },
                status: 'finished',
                title: 'Old OpenCode scan',
            },
            {
                createdAt: '2026-11-21T10:00:00Z',
                id: '2',
                provider: { name: 'openai', type: 'openai' },
                status: 'running',
                title: 'Plain OpenAI flow',
            },
            {
                createdAt: '2026-11-22T10:00:00Z',
                id: '3',
                provider: { name: 'claude-cli', type: 'custom' },
                status: 'running',
                title: 'New CLI scan',
            },
        ];
        renderPage();

        const list = screen.getByRole('list', { name: 'Recent Agent Mode sessions' });
        const links = within(list).getAllByRole('link');

        expect(links).toHaveLength(2);
        expect(links[0]).toHaveTextContent('New CLI scan');
        expect(links[0]).toHaveTextContent('Running');
        expect(links[0]).toHaveAttribute('href', '/flows/3');
        expect(links[1]).toHaveTextContent('Old OpenCode scan');
        expect(links[1]).toHaveTextContent('Finished');
        expect(screen.queryByText('Plain OpenAI flow')).not.toBeInTheDocument();
    });
});
