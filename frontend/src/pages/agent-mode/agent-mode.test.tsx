import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({
    createFlow: vi.fn(),
    createFlowWithAssistant: vi.fn(),
    deleteFlow: vi.fn(),
    finishFlow: vi.fn(),
    flowContext: {} as Record<string, unknown>,
    flows: [] as Array<Record<string, unknown>>,
    isDesktop: true,
    providers: [] as Array<{ name: string; type: string }>,
    selectedProvider: null as null | { name: string; type: string },
    setSelectedProvider: vi.fn(),
}));

vi.mock('@/components/layouts/app/app-header', () => {
    const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

    const AppHeaderAction = ({
        icon: _icon,
        label,
        loading: _loading,
        ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        icon?: React.ReactNode;
        label: React.ReactNode;
        loading?: boolean;
        variant?: string;
    }) => {
        const { variant: _variant, ...rest } = props;

        return (
            <button
                type="button"
                {...rest}
            >
                {label}
            </button>
        );
    };

    return {
        AppHeader: Pass,
        AppHeaderAction,
        AppHeaderActions: Pass,
        AppHeaderContent: Pass,
        AppHeaderTitle: Pass,
    };
});

vi.mock('@/hooks/use-breakpoint', () => ({
    useBreakpoint: () => ({ isDesktop: mocks.isDesktop, isMobile: false, isTablet: !mocks.isDesktop }),
}));

vi.mock('@/components/ui/resizable', () => {
    const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

    return { ResizableHandle: () => <hr />, ResizablePanel: Pass, ResizablePanelGroup: Pass };
});

vi.mock('@/features/flows/flow-central-tabs', () => ({
    default: () => <div data-slot="flow-central-tabs">central tabs</div>,
}));

vi.mock('@/features/flows/flow-tabs', () => ({
    default: ({ activeTab }: { activeTab: string }) => <div data-slot="flow-tabs">flow tabs: {activeTab}</div>,
}));

vi.mock('@/hooks/use-flow-tab-detection', () => ({
    FLOW_TAB_VALUES: [],
    useFlowSideTab: () => ({ handleTabChange: vi.fn(), resolvedTab: 'terminal' }),
    useFlowTabDetection: () => ({ handleTabChange: vi.fn(), resolvedTab: 'automation' }),
}));

vi.mock('@apollo/client/react', () => ({
    useMutation: () => [vi.fn(), { loading: false }],
}));

vi.mock('@/providers/flow-provider', () => ({
    useFlow: () => mocks.flowContext,
}));

vi.mock('@/providers/flows-provider', () => ({
    useFlows: () => ({
        createFlow: mocks.createFlow,
        createFlowWithAssistant: mocks.createFlowWithAssistant,
        deleteFlow: mocks.deleteFlow,
        finishFlow: mocks.finishFlow,
    }),
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

function LegacyFlowPage() {
    return <p>legacy flow page</p>;
}

function LocationProbe() {
    const location = useLocation();

    return <p data-slot="location">{`${location.pathname}${location.search}`}</p>;
}

const renderAt = (path: string) =>
    render(
        <TooltipProvider>
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route
                        element={<AgentMode />}
                        path="/agent-mode"
                    />
                    <Route
                        element={<AgentMode />}
                        path="/agent-mode/:flowId"
                    />
                    <Route
                        element={<LegacyFlowPage />}
                        path="/flows/*"
                    />
                </Routes>
                <LocationProbe />
            </MemoryRouter>
        </TooltipProvider>,
    );

const submitTask = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
    await user.type(screen.getByRole('textbox'), text);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
};

const cliFlows = [
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
        title: '',
    },
];

const sessionFlow = {
    createdAt: '2026-11-22T10:00:00Z',
    id: '3',
    provider: { name: 'OpenCode', type: 'custom' },
    status: 'running',
    title: 'Recon on 10.0.0.5',
};

beforeEach(() => {
    window.localStorage.clear();
    mocks.createFlow.mockReset();
    mocks.createFlowWithAssistant.mockReset();
    mocks.deleteFlow.mockReset();
    mocks.finishFlow.mockReset();
    mocks.setSelectedProvider.mockReset();
    mocks.isDesktop = true;
    mocks.providers = [
        { name: 'claude-cli', type: 'custom' },
        { name: 'openai', type: 'openai' },
        { name: 'OpenCode', type: 'custom' },
    ];
    mocks.selectedProvider = { name: 'openai', type: 'openai' };
    mocks.flows = [];
    mocks.flowContext = {
        flowData: { flow: sessionFlow, messageLogs: [], tasks: [] },
        flowId: '3',
        flowLoadError: undefined,
        isFlowMissing: false,
        isLoading: false,
        refetchFlow: vi.fn(),
    };
});

describe('AgentMode new thread', () => {
    it('lists only the custom CLI providers and selects OpenCode by default', () => {
        renderAt('/agent-mode');

        const group = screen.getByRole('radiogroup', { name: 'CLI agent providers' });
        const cards = within(group).getAllByRole('radio');

        expect(cards.map((card) => card.textContent)).toEqual([
            expect.stringContaining('claude-cli'),
            expect.stringContaining('OpenCode'),
        ]);
        expect(within(group).getByRole('radio', { name: /OpenCode/ })).toHaveAttribute('aria-checked', 'true');
        expect(within(group).getByRole('radio', { name: /claude-cli/ })).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText('Runs on OpenCode')).toBeInTheDocument();
        expect(screen.getByText('Same PentAGI system prompts, rules & isolated Docker sandbox')).toBeInTheDocument();
    });

    it('falls back to every provider when none is custom', () => {
        mocks.providers = [{ name: 'openai', type: 'openai' }];
        renderAt('/agent-mode');

        expect(screen.getByRole('radio', { name: /openai/ })).toHaveAttribute('aria-checked', 'true');
    });

    it('switches provider on card click and submits the thread with it', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlow.mockResolvedValue('7');
        renderAt('/agent-mode');

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

    it('opens a new automation thread inside Agent Mode', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlow.mockResolvedValue('42');
        renderAt('/agent-mode');

        await submitTask(user, 'scan 10.0.0.5');

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/agent-mode/42?tab=automation'));
        expect(screen.queryByText('legacy flow page')).not.toBeInTheDocument();
        expect(mocks.createFlow.mock.calls[0]?.[0]).toMatchObject({ providerName: 'OpenCode' });
        expect(mocks.createFlowWithAssistant).not.toHaveBeenCalled();
    });

    it('opens a new assistant thread inside Agent Mode', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlowWithAssistant.mockResolvedValue('43');
        renderAt('/agent-mode');

        await user.click(screen.getByRole('tab', { name: 'Assistant' }));
        await submitTask(user, 'help me enumerate');

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/agent-mode/43?tab=assistant'));
        expect(screen.queryByText('legacy flow page')).not.toBeInTheDocument();
        expect(mocks.createFlowWithAssistant.mock.calls[0]?.[0]).toMatchObject({ providerName: 'OpenCode' });
        expect(mocks.createFlow).not.toHaveBeenCalled();
    });

    it('stays on the composer when the flow was not created', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.createFlow.mockResolvedValue(null);
        renderAt('/agent-mode');

        await submitTask(user, 'scan 10.0.0.5');

        await waitFor(() => expect(mocks.createFlow).toHaveBeenCalledOnce());
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/agent-mode$/);
    });
});

describe('AgentMode thread rail', () => {
    it('lists CLI threads newest first and links each one into Agent Mode', () => {
        mocks.flows = cliFlows;
        renderAt('/agent-mode');

        const list = screen.getByRole('list', { name: 'Agent threads' });
        const links = within(list).getAllByRole('link');

        expect(links).toHaveLength(2);
        expect(links[0]).toHaveTextContent('Session #3');
        expect(links[0]).toHaveTextContent('claude-cli');
        expect(links[0]).toHaveAttribute('href', '/agent-mode/3');
        expect(links[1]).toHaveTextContent('Old OpenCode scan');
        expect(links[1]).toHaveAttribute('href', '/agent-mode/1');
        expect(screen.queryByText('Plain OpenAI flow')).not.toBeInTheDocument();
    });

    it('offers a new thread link, provider settings and the connected CLI agent pills', () => {
        renderAt('/agent-mode');

        expect(screen.getByRole('link', { name: 'New thread' })).toHaveAttribute('href', '/agent-mode');
        expect(screen.getByRole('link', { name: 'Manage providers' })).toHaveAttribute('href', '/settings/providers');

        const pills = within(screen.getByRole('group', { name: 'Connected CLI agents' })).getAllByRole('button');

        expect(pills.map((pill) => pill.textContent)).toEqual(['claude-cli', 'OpenCode']);
        expect(pills[1]).toHaveAttribute('aria-pressed', 'true');
    });

    it('highlights the open thread and switches threads without leaving Agent Mode', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.flows = cliFlows;
        renderAt('/agent-mode/3');

        const list = screen.getByRole('list', { name: 'Agent threads' });

        expect(within(list).getByRole('link', { current: 'page' })).toHaveAttribute('href', '/agent-mode/3');

        await user.click(within(list).getByRole('link', { name: /Old OpenCode scan/ }));

        expect(screen.getByTestId('location')).toHaveTextContent(/^\/agent-mode\/1$/);
        expect(screen.queryByText('legacy flow page')).not.toBeInTheDocument();
    });

    it('collapses and restores the rail', async () => {
        const user = userEvent.setup({ delay: null });
        renderAt('/agent-mode');

        await user.click(screen.getByRole('button', { name: 'Hide threads' }));

        expect(screen.queryByRole('complementary', { name: 'Agent Mode threads' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Show threads' }));

        expect(screen.getByRole('complementary', { name: 'Agent Mode threads' })).toBeInTheDocument();
    });

    it('starts a new thread on the provider picked from a pill inside a session', async () => {
        const user = userEvent.setup({ delay: null });
        renderAt('/agent-mode/3');

        await user.click(
            within(screen.getByRole('group', { name: 'Connected CLI agents' })).getByRole('button', {
                name: 'claude-cli',
            }),
        );

        expect(screen.getByTestId('location')).toHaveTextContent(/^\/agent-mode$/);
        expect(screen.getByRole('radio', { name: /claude-cli/ })).toHaveAttribute('aria-checked', 'true');
    });
});

describe('AgentMode active thread', () => {
    it('renders the thread header, the live conversation and the workbench', () => {
        renderAt('/agent-mode/3');

        expect(screen.getByText('Recon on 10.0.0.5')).toBeInTheDocument();
        expect(screen.getByText('#3')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Agent Mode' })).toHaveAttribute('href', '/agent-mode');
        expect(screen.getAllByText('OpenCode').length).toBeGreaterThan(0);
        expect(screen.getByTestId('flow-central-tabs')).toBeInTheDocument();
        expect(screen.getByTestId('flow-tabs')).toHaveTextContent('flow tabs: terminal');
        expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument();
    });

    it('toggles the workbench from the header and its close button', async () => {
        const user = userEvent.setup({ delay: null });
        renderAt('/agent-mode/3');

        const toggle = screen.getByRole('button', { name: 'Toggle workbench' });

        expect(toggle).toHaveAttribute('aria-pressed', 'true');

        await user.click(toggle);

        expect(screen.queryByTestId('flow-tabs')).not.toBeInTheDocument();
        expect(screen.getByTestId('flow-central-tabs')).toBeInTheDocument();
        expect(toggle).toHaveAttribute('aria-pressed', 'false');

        await user.click(toggle);

        expect(screen.getByTestId('flow-tabs')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Close workbench' }));

        expect(screen.queryByTestId('flow-tabs')).not.toBeInTheDocument();
    });

    it('hides Finish once the thread is finished', () => {
        mocks.flowContext = {
            ...mocks.flowContext,
            flowData: { flow: { ...sessionFlow, status: 'finished' }, messageLogs: [], tasks: [] },
        };
        renderAt('/agent-mode/3');

        expect(screen.queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument();
    });

    it('finishes a running thread', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.finishFlow.mockResolvedValue(undefined);
        renderAt('/agent-mode/3');

        await user.click(screen.getByRole('button', { name: 'Finish' }));

        expect(mocks.finishFlow).toHaveBeenCalledWith(sessionFlow);
    });

    it('returns to Agent Mode, not Flows, after deleting the thread', async () => {
        const user = userEvent.setup({ delay: null });
        mocks.deleteFlow.mockResolvedValue(true);
        renderAt('/agent-mode/3');

        await user.click(screen.getByRole('button', { name: 'Delete thread' }));
        await user.click(await screen.findByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/agent-mode$/));
        expect(mocks.deleteFlow).toHaveBeenCalledWith(sessionFlow);
    });

    it('redirects a missing thread back to Agent Mode', async () => {
        mocks.flowContext = { ...mocks.flowContext, flowData: { flow: null }, isFlowMissing: true };
        renderAt('/agent-mode/999');

        await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/agent-mode$/));
        expect(screen.queryByText('legacy flow page')).not.toBeInTheDocument();
    });

    it('shows the load error with a retry', async () => {
        const user = userEvent.setup({ delay: null });
        const refetchFlow = vi.fn();
        mocks.flowContext = {
            ...mocks.flowContext,
            flowData: undefined,
            flowLoadError: new Error('boom'),
            refetchFlow,
        };
        renderAt('/agent-mode/3');

        expect(screen.getByText('Error loading agent thread')).toBeInTheDocument();
        expect(screen.queryByTestId('flow-central-tabs')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Try again' }));

        expect(refetchFlow).toHaveBeenCalled();
    });

    it('shows a loading overlay while the thread loads', () => {
        mocks.flowContext = { ...mocks.flowContext, isLoading: true };
        renderAt('/agent-mode/3');

        expect(screen.getByRole('status', { name: 'Loading agent thread' })).toBeInTheDocument();
    });

    it('falls back to the combined tab strip below desktop width', () => {
        mocks.isDesktop = false;
        renderAt('/agent-mode/3');

        expect(screen.getByTestId('flow-tabs')).toHaveTextContent('flow tabs: automation');
        expect(screen.queryByTestId('flow-central-tabs')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Toggle workbench' })).not.toBeInTheDocument();
    });
});
