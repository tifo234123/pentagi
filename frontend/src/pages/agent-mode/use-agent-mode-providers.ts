import { useCallback, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';

import type { Provider } from '@/models/provider';
import type { Flow } from '@/providers/sidebar-flows-provider';

import { ProviderType } from '@/graphql/types';
import { useProviders } from '@/providers/providers-provider';
import { useSidebarFlows } from '@/providers/sidebar-flows-provider';

export interface AgentModeLocationState {
    providerName?: string;
}

export const isOpenCodeProvider = (provider: Pick<Provider, 'name'>) =>
    provider.name.toLowerCase().includes('opencode');

export function useAgentModeProviderSelection() {
    const location = useLocation();
    const { providers, selectedProvider, setSelectedProvider } = useProviders();
    const cliProviders = useCliProviders();

    const requestedName = (location.state as AgentModeLocationState | null)?.providerName ?? null;

    const [pickedProviderName, setPickedProviderName] = useState<null | string>(requestedName);
    const [seenSelectedName, setSeenSelectedName] = useState(selectedProvider?.name ?? null);
    const [isFormProviderDirty, setIsFormProviderDirty] = useState(false);
    const [formKey, setFormKey] = useState(0);

    // The form's own provider dropdown writes to the shared selection; follow it so the highlighted
    // card matches what will be submitted. The first null -> name step is the providers query
    // loading, not a user pick, and must not beat the OpenCode default.
    const currentSelectedName = selectedProvider?.name ?? null;

    if (currentSelectedName !== seenSelectedName) {
        setSeenSelectedName(currentSelectedName);

        if (seenSelectedName !== null && currentSelectedName && currentSelectedName !== pickedProviderName) {
            setPickedProviderName(currentSelectedName);
            setIsFormProviderDirty(true);
        }
    }

    const activeProvider = useMemo(() => {
        const picked = pickedProviderName ? providers.find((provider) => provider.name === pickedProviderName) : null;

        return (
            picked ??
            cliProviders.find(isOpenCodeProvider) ??
            cliProviders.find((provider) => provider.type === ProviderType.Custom) ??
            selectedProvider ??
            null
        );
    }, [cliProviders, pickedProviderName, providers, selectedProvider]);

    const selectProvider = useCallback(
        (provider: Provider) => {
            setPickedProviderName(provider.name);
            setSelectedProvider(provider);

            // FlowForm never overwrites a dirty field from defaultValues, so a pick made in its
            // dropdown needs a remount for the card choice to win.
            if (isFormProviderDirty) {
                setIsFormProviderDirty(false);
                setFormKey((key) => key + 1);
            }
        },
        [isFormProviderDirty, setSelectedProvider],
    );

    return { activeProvider, cliProviders, formKey, selectProvider };
}

export function useAgentThreads(): Flow[] {
    const { flows } = useSidebarFlows();
    const cliProviders = useCliProviders();

    return useMemo(() => {
        const names = new Set(cliProviders.map((provider) => provider.name));

        return flows
            .filter((flow) => flow.provider.type === ProviderType.Custom || names.has(flow.provider.name))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [cliProviders, flows]);
}

export function useCliProviders() {
    const { providers } = useProviders();

    return useMemo(() => {
        const custom = providers.filter((provider) => provider.type === ProviderType.Custom);

        return custom.length > 0 ? custom : providers;
    }, [providers]);
}
