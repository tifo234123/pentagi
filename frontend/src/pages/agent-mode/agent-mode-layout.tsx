import type { ReactNode } from 'react';

import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useState } from 'react';

import type { Provider } from '@/models/provider';

import { AppHeader, AppHeaderActions, AppHeaderContent } from '@/components/layouts/app/app-header';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useBreakpoint } from '@/hooks/use-breakpoint';

import AgentModeRail from './agent-mode-rail';
import { usePersistedToggle } from './use-persisted-toggle';

const RAIL_STORAGE_KEY = 'agent-mode:rail-open';

interface AgentModeLayoutProps {
    activeFlowId?: null | string;
    activeProviderName?: null | string;
    children: ReactNode;
    headerActions?: ReactNode;
    headerTitle: ReactNode;
    onSelectProvider: (provider: Provider) => void;
}

function AgentModeLayout({
    activeFlowId,
    activeProviderName,
    children,
    headerActions,
    headerTitle,
    onSelectProvider,
}: AgentModeLayoutProps) {
    const { isDesktop } = useBreakpoint();
    const [isRailOpen, , toggleRail] = usePersistedToggle(RAIL_STORAGE_KEY, true);
    const [isRailSheetOpen, setIsRailSheetOpen] = useState(false);

    const isRailShown = isDesktop ? isRailOpen : isRailSheetOpen;

    const rail = (
        <AgentModeRail
            activeFlowId={activeFlowId}
            activeProviderName={activeProviderName}
            onNavigate={isDesktop ? undefined : () => setIsRailSheetOpen(false)}
            onSelectProvider={(provider) => {
                onSelectProvider(provider);

                if (!isDesktop) {
                    setIsRailSheetOpen(false);
                }
            }}
        />
    );

    return (
        <>
            <AppHeader>
                <AppHeaderContent>
                    <Button
                        aria-expanded={isRailShown}
                        aria-label={isRailShown ? 'Hide threads' : 'Show threads'}
                        className="size-7 shrink-0"
                        onClick={isDesktop ? toggleRail : () => setIsRailSheetOpen(true)}
                        size="icon"
                        variant="ghost"
                    >
                        {isRailShown ? <PanelLeftClose /> : <PanelLeftOpen />}
                    </Button>
                    {headerTitle}
                </AppHeaderContent>
                {headerActions && <AppHeaderActions>{headerActions}</AppHeaderActions>}
            </AppHeader>
            <div className="flex h-[calc(100dvh-3rem)] min-h-0 w-full max-w-full">
                {isDesktop && isRailOpen && (
                    <aside
                        aria-label="Agent Mode threads"
                        className="bg-muted/30 w-[260px] shrink-0 border-r"
                    >
                        {rail}
                    </aside>
                )}
                <main className="relative flex min-w-0 flex-1 flex-col">{children}</main>
            </div>
            {!isDesktop && (
                <Sheet
                    onOpenChange={setIsRailSheetOpen}
                    open={isRailSheetOpen}
                >
                    <SheetContent
                        className="w-[280px] p-0 pt-10"
                        side="left"
                    >
                        <SheetTitle className="sr-only">Agent Mode threads</SheetTitle>
                        <SheetDescription className="sr-only">
                            Start a new thread or switch between CLI agent sessions
                        </SheetDescription>
                        {rail}
                    </SheetContent>
                </Sheet>
            )}
        </>
    );
}

export default AgentModeLayout;
