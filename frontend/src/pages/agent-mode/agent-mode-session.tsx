import { useMutation } from '@apollo/client/react';
import { PanelRightClose, PanelRightOpen, Pause, Trash, Wrench, X } from 'lucide-react';
import { startTransition, useCallback, useEffect, useOptimistic, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import type { Provider } from '@/models/provider';

import { FlowStatusIcon } from '@/components/icons/flow-status-icon';
import { ProviderIcon } from '@/components/icons/provider-icon';
import { AppHeaderAction } from '@/components/layouts/app/app-header';
import ConfirmationDialog from '@/components/shared/confirmation-dialog';
import { ErrorState } from '@/components/shared/error-state';
import { InlineEditInput, useInlineEdit } from '@/components/shared/inline-edit';
import { Badge } from '@/components/ui/badge';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Spinner } from '@/components/ui/spinner';
import FlowCentralTabs from '@/features/flows/flow-central-tabs';
import FlowTabs from '@/features/flows/flow-tabs';
import { RenameFlowDocument, ResultType, StatusType } from '@/graphql/types';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { FLOW_TAB_VALUES, useFlowSideTab, useFlowTabDetection } from '@/hooks/use-flow-tab-detection';
import { routes } from '@/lib/routes';
import { formatName } from '@/lib/utils/format';
import { useFlow } from '@/providers/flow-provider';
import { useFlows } from '@/providers/flows-provider';

import type { AgentModeLocationState } from './use-agent-mode-providers';

import AgentModeLayout from './agent-mode-layout';
import { usePersistedToggle } from './use-persisted-toggle';

const INSPECTOR_STORAGE_KEY = 'agent-mode:workbench-open';

function AgentModeSession() {
    const navigate = useNavigate();
    const { isDesktop } = useBreakpoint();

    const { flowData, flowId, flowLoadError, isFlowMissing, isLoading, refetchFlow } = useFlow();
    const { deleteFlow, finishFlow } = useFlows();

    const flow = flowData?.flow;
    const isFlowRunning = flow ? ![StatusType.Failed, StatusType.Finished].includes(flow.status) : false;

    const [isInspectorOpen, , toggleInspector] = usePersistedToggle(INSPECTOR_STORAGE_KEY, true);
    const [isFinishing, setIsFinishing] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

    const actualTitle = flow?.title ?? '';
    const [flowTitle, setOptimisticFlowTitle] = useOptimistic(actualTitle, (_current, next: string) => next);
    const [renameFlowMutation, { loading: isRenameLoading }] = useMutation(RenameFlowDocument);
    const {
        inputRef: editingInputRef,
        isEditing: isEditingTitle,
        startEdit: handleRenameStart,
        stopEdit: handleRenameCancel,
    } = useInlineEdit({ resetKey: flowId });

    useEffect(() => {
        if (isFlowMissing) {
            navigate(routes.agentMode, { replace: true });
        }
    }, [isFlowMissing, navigate]);

    const { handleTabChange: handleSideTabChange, resolvedTab: sideTab } = useFlowSideTab();
    const { handleTabChange: handleCompactTabChange, resolvedTab: compactTab } = useFlowTabDetection(FLOW_TAB_VALUES);

    const handleRenameSave = useCallback(async () => {
        const newTitle = editingInputRef.current?.value.trim();

        if (!flowId || !newTitle) {
            return;
        }

        startTransition(async () => {
            setOptimisticFlowTitle(newTitle);

            try {
                const { data } = await renameFlowMutation({ variables: { flowId, title: newTitle } });

                if (data?.renameFlow === ResultType.Success) {
                    toast.success('Thread renamed');
                    handleRenameCancel();
                }
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Failed to rename thread');
            }
        });
    }, [editingInputRef, flowId, handleRenameCancel, renameFlowMutation, setOptimisticFlowTitle]);

    const handleFinish = useCallback(async () => {
        if (!flow) {
            return;
        }

        setIsFinishing(true);

        try {
            await finishFlow(flow);
        } finally {
            setIsFinishing(false);
        }
    }, [flow, finishFlow]);

    const handleDelete = useCallback(async () => {
        if (!flow) {
            return;
        }

        setIsDeleting(true);

        try {
            if (await deleteFlow(flow)) {
                navigate(routes.agentMode, { replace: true });
            }
        } finally {
            setIsDeleting(false);
        }
    }, [flow, deleteFlow, navigate]);

    const handleSelectProvider = useCallback(
        (provider: Provider) => {
            const state: AgentModeLocationState = { providerName: provider.name };

            navigate(routes.agentMode, { state });
        },
        [navigate],
    );

    const headerTitle = (
        <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="min-w-0 flex-nowrap">
                <BreadcrumbItem className="hidden shrink-0 md:inline-flex">
                    <BreadcrumbLink asChild>
                        <Link to={routes.agentMode}>Agent Mode</Link>
                    </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem className="min-w-0 gap-2">
                    {flow && (
                        <FlowStatusIcon
                            status={flow.status}
                            tooltip={formatName(flow.status)}
                        />
                    )}
                    {isEditingTitle && flow ? (
                        <InlineEditInput
                            busy={isRenameLoading}
                            className="w-64 max-w-full min-w-0 flex-1"
                            defaultValue={flowTitle}
                            inputRef={editingInputRef}
                            onCancel={handleRenameCancel}
                            onSave={handleRenameSave}
                            placeholder="Thread title"
                        />
                    ) : (
                        <BreadcrumbPage
                            className="max-w-72 min-w-0 cursor-text truncate select-none"
                            onDoubleClick={flow ? handleRenameStart : undefined}
                            title={flow ? 'Double-click to rename' : undefined}
                        >
                            {flowTitle || (flowId ? `Session #${flowId}` : 'Agent thread')}
                        </BreadcrumbPage>
                    )}
                    {flowId && (
                        <Badge
                            className="shrink-0 font-mono text-[10px]"
                            variant="outline"
                        >
                            #{flowId}
                        </Badge>
                    )}
                    {flow && (
                        <Badge
                            className="hidden shrink-0 gap-1 font-normal sm:inline-flex"
                            variant="secondary"
                        >
                            <ProviderIcon
                                className="size-3"
                                provider={flow.provider}
                            />
                            {flow.provider.name}
                        </Badge>
                    )}
                </BreadcrumbItem>
            </BreadcrumbList>
        </Breadcrumb>
    );

    const headerActions = (
        <>
            {isFlowRunning && (
                <AppHeaderAction
                    icon={<Pause />}
                    label="Finish"
                    loading={isFinishing}
                    onClick={handleFinish}
                    variant="outline"
                />
            )}
            <Button
                aria-label="Delete thread"
                className="size-8"
                disabled={!flow || isDeleting}
                onClick={() => setIsDeleteDialogOpen(true)}
                size="icon"
                variant="ghost"
            >
                {isDeleting ? <Spinner variant="circle" /> : <Trash />}
            </Button>
            {isDesktop && (
                <AppHeaderAction
                    aria-label="Toggle workbench"
                    aria-pressed={isInspectorOpen}
                    icon={isInspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
                    label="Workbench"
                    onClick={toggleInspector}
                    variant={isInspectorOpen ? 'secondary' : 'ghost'}
                />
            )}
        </>
    );

    const conversation = (
        <div className="flex h-full min-w-0 flex-col">
            <div className="flex-1 overflow-auto py-4 pl-4">
                <FlowCentralTabs />
            </div>
        </div>
    );

    const inspector = (
        <section
            aria-label="Workbench"
            className="bg-muted/20 flex h-full min-w-0 flex-col"
        >
            <div className="text-muted-foreground flex h-9 shrink-0 items-center justify-between border-b px-4 text-xs font-medium tracking-wide uppercase">
                <span className="flex items-center gap-1.5">
                    <Wrench className="size-3.5" />
                    Workbench
                </span>
                <Button
                    aria-label="Close workbench"
                    className="size-6"
                    onClick={toggleInspector}
                    size="icon"
                    variant="ghost"
                >
                    <X className="size-3.5" />
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-3 pl-4">
                <FlowTabs
                    activeTab={sideTab}
                    onTabChange={handleSideTabChange}
                />
            </div>
        </section>
    );

    let body;

    if (flowLoadError) {
        body = (
            <div className="flex flex-1 flex-col gap-4 p-4">
                <ErrorState
                    message={flowLoadError.message}
                    onRetry={refetchFlow}
                    title="Error loading agent thread"
                />
            </div>
        );
    } else if (!isDesktop) {
        body = (
            <div className="min-h-0 flex-1 overflow-auto py-4 pl-4">
                <FlowTabs
                    activeTab={compactTab}
                    onTabChange={handleCompactTabChange}
                />
            </div>
        );
    } else if (isInspectorOpen) {
        body = (
            <ResizablePanelGroup
                className="min-h-0 flex-1"
                orientation="horizontal"
            >
                <ResizablePanel
                    defaultSize="58%"
                    minSize={420}
                >
                    {conversation}
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel
                    defaultSize="42%"
                    minSize={360}
                >
                    {inspector}
                </ResizablePanel>
            </ResizablePanelGroup>
        );
    } else {
        body = <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">{conversation}</div>;
    }

    return (
        <AgentModeLayout
            activeFlowId={flowId}
            activeProviderName={flow?.provider.name}
            headerActions={flowLoadError ? undefined : headerActions}
            headerTitle={headerTitle}
            onSelectProvider={handleSelectProvider}
        >
            {isLoading && !flowLoadError && (
                <div
                    aria-label="Loading agent thread"
                    className="bg-background/50 absolute inset-0 z-50 flex items-center justify-center"
                    role="status"
                >
                    <Spinner
                        className="size-12"
                        variant="circle"
                    />
                </div>
            )}
            {body}
            <ConfirmationDialog
                cancelText="Cancel"
                confirmText="Delete"
                handleConfirm={handleDelete}
                handleOpenChange={setIsDeleteDialogOpen}
                isOpen={isDeleteDialogOpen}
                itemName={flow?.title}
                itemType="thread"
            />
        </AgentModeLayout>
    );
}

export default AgentModeSession;
