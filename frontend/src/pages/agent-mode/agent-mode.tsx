import { useParams } from 'react-router-dom';

import AgentModeComposer from './agent-mode-composer';
import AgentModeSession from './agent-mode-session';

// `/agent-mode/:flowId` is mounted inside FlowProvider by the router; `/agent-mode` is not, so the
// session view (which reads useFlow) must only render when the param is present.
function AgentMode() {
    const { flowId } = useParams();

    return flowId ? <AgentModeSession /> : <AgentModeComposer />;
}

export default AgentMode;
