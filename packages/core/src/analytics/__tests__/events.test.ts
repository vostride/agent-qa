import { describe, expect, it } from 'vitest'
import { buildAnalyticsEvent } from '../events.js'
import { getAgentQaVersion } from '../../version.js'

const testId = 't_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const suiteId = 's_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'
const runId = 'r_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'

describe('analytics event builder', () => {
  it('preserves allowlisted foundation properties and disables PostHog person profiles', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'cli',
        runtime_context: 'user',
        agent_qa_version: '0.1.0',
      },
    })

    expect(event.name).toBe('agent-qa.analytics.test_event')
    expect(event.properties).toMatchObject({
      surface: 'cli',
      runtime_context: 'user',
      agent_qa_version: '0.1.0',
      $process_person_profile: false,
    })
  })

  it('allows raw canonical test, suite, and run ids', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'core',
        runtime_context: 'user',
        test_id: testId,
        suite_id: suiteId,
        run_id: runId,
      },
    })

    expect(event.properties.test_id).toBe(testId)
    expect(event.properties.suite_id).toBe(suiteId)
    expect(event.properties.run_id).toBe(runId)
    expect(event.properties.agent_qa_version).toBe(getAgentQaVersion())
  })

  it('adds package version when callers omit analytics standard properties', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.dashboard.opened',
      properties: {
        surface: 'dashboard-ui',
        route: '/secret',
      },
    })

    expect(event.properties).toMatchObject({
      agent_qa_version: getAgentQaVersion(),
      surface: 'dashboard-ui',
      $process_person_profile: false,
    })
    expect(event.properties).not.toHaveProperty('route')
  })

  it('builds test run completion events with safe aggregate properties', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.test_run.completed',
      properties: {
        agent_qa_version: '0.1.0',
        surface: 'cli',
        runtime_context: 'user',
        run_id: runId,
        parent_run_id: 'r_parent-alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india',
        test_id: testId,
        trigger_source: 'dashboard',
        runner: 'local',
        platform: 'web',
        browser_name: 'chromium',
        status: 'passed',
        duration_ms: 1234,
        retry_count: 1,
        is_flaky: true,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        step_count: 2,
        passed_step_count: 2,
        subaction_count: 4,
        cached_subaction_count: 1,
        healing_attempt_count: 0,
        hook_count: 1,
        failed_hook_count: 0,
        memory_enabled: true,
        memory_added_count: 1,
        memory_confirmed_count: 2,
      },
    })

    expect(event.name).toBe('agent-qa.test_run.completed')
    expect(event.properties).toMatchObject({
      agent_qa_version: '0.1.0',
      surface: 'cli',
      runtime_context: 'user',
      run_id: runId,
      test_id: testId,
      trigger_source: 'dashboard',
      runner: 'local',
      platform: 'web',
      browser_name: 'chromium',
      status: 'passed',
      duration_ms: 1234,
      retry_count: 1,
      is_flaky: true,
      $process_person_profile: false,
    })
  })

  it('builds suite run completion events with parent aggregate properties only', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.suite_run.completed',
      properties: {
        agent_qa_version: '0.1.0',
        surface: 'cli',
        runtime_context: 'ci',
        run_id: runId,
        suite_id: suiteId,
        trigger_source: 'mcp',
        runner: 'browserstack',
        status: 'failed',
        duration_ms: 4567,
        suite_child_count: 3,
        suite_passed_count: 1,
        suite_failed_count: 2,
        suite_skipped_count: 0,
        suite_execution_mode: 'parallel',
        suite_name: 'Sensitive Suite Name',
        suite_file_path: '/Users/example/project/suites/private.suite.yaml',
        child_ids: [testId],
        child_failure_details: 'raw assertion text',
      },
    })

    expect(event.name).toBe('agent-qa.suite_run.completed')
    expect(event.properties).toMatchObject({
      run_id: runId,
      suite_id: suiteId,
      trigger_source: 'mcp',
      runner: 'browserstack',
      suite_child_count: 3,
      suite_failed_count: 2,
      suite_execution_mode: 'parallel',
      $process_person_profile: false,
    })
    expect(event.properties).not.toHaveProperty('suite_name')
    expect(event.properties).not.toHaveProperty('suite_file_path')
    expect(event.properties).not.toHaveProperty('child_ids')
    expect(event.properties).not.toHaveProperty('child_failure_details')
  })

  it('rejects invalid runtime context values', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'cli',
        runtime_context: 'local',
      },
    })).toThrow()
  })

  it('rejects invalid agent product values', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'cli',
        runtime_context: 'agent',
        agent_product: 'raw-agent-product',
      },
    })).toThrow()
  })

  it('drops sensitive unsupported fields before PostHog capture', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.test_run.completed',
      properties: {
        surface: 'cli',
        runtime_context: 'agent',
        agent_product: 'goose',
        run_id: runId,
        test_id: testId,
        status: 'failed',
        test_name: 'phase242-sensitive-sentinel',
        file_path: '/Users/example/project/tests/login.yaml',
        url: 'https://secret.example/app',
        prompt: 'raw prompt text',
        error: 'stack trace',
        error_message: 'raw error message',
        console_logs: ['secret console'],
        hook_stdout: 'hook secret',
        memory_content: 'remember this raw content',
        run_attr_customer: 'customer-123',
        authState: 'analytics-demo-acc',
        storageStatePath: '/internal/auth/staging-web/analytics-demo-acc/storage-state.json',
        cookies: [{ name: 'sid', value: 'analytics-cookie-secret' }],
        localStorage: [{ name: 'token', value: 'analytics-local-storage-secret' }],
        indexedDB: [{ name: 'auth-db', value: 'analytics-indexed-db-secret' }],
        envValue: 'CLAUDECODE=1',
        mcpPayload: { raw: true },
        secret: 'sk-test-phase242',
      },
    })

    const serializedProperties = JSON.stringify(event.properties)
    expect(event.properties).not.toHaveProperty('test_name')
    expect(event.properties).not.toHaveProperty('file_path')
    expect(event.properties).not.toHaveProperty('url')
    expect(event.properties).not.toHaveProperty('prompt')
    expect(event.properties).not.toHaveProperty('error')
    expect(event.properties).not.toHaveProperty('error_message')
    expect(event.properties).not.toHaveProperty('console_logs')
    expect(event.properties).not.toHaveProperty('hook_stdout')
    expect(event.properties).not.toHaveProperty('memory_content')
    expect(event.properties).not.toHaveProperty('run_attr_customer')
    expect(event.properties).not.toHaveProperty('authState')
    expect(event.properties).not.toHaveProperty('storageStatePath')
    expect(event.properties).not.toHaveProperty('cookies')
    expect(event.properties).not.toHaveProperty('localStorage')
    expect(event.properties).not.toHaveProperty('indexedDB')
    expect(event.properties).not.toHaveProperty('envValue')
    expect(event.properties).not.toHaveProperty('mcpPayload')
    expect(event.properties).not.toHaveProperty('secret')
    expect(serializedProperties).not.toContain('phase242-sensitive-sentinel')
    expect(serializedProperties).not.toContain('/Users/example/project/tests/login.yaml')
    expect(serializedProperties).not.toContain('https://secret.example/app')
    expect(serializedProperties).not.toContain('raw prompt text')
    expect(serializedProperties).not.toContain('stack trace')
    expect(serializedProperties).not.toContain('raw error message')
    expect(serializedProperties).not.toContain('secret console')
    expect(serializedProperties).not.toContain('hook secret')
    expect(serializedProperties).not.toContain('remember this raw content')
    expect(serializedProperties).not.toContain('customer-123')
    expect(serializedProperties).not.toContain('analytics-demo-acc')
    expect(serializedProperties).not.toContain('analytics-cookie-secret')
    expect(serializedProperties).not.toContain('analytics-local-storage-secret')
    expect(serializedProperties).not.toContain('analytics-indexed-db-secret')
    expect(serializedProperties).not.toContain('CLAUDECODE=1')
    expect(serializedProperties).not.toContain('sk-test-phase242')
  })

  it('rejects negative aggregate counts', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.test_run.completed',
      properties: {
        surface: 'cli',
        runtime_context: 'user',
        run_id: runId,
        test_id: testId,
        status: 'passed',
        step_count: -1,
      },
    })).toThrow()
  })

  it('drops raw dashboard route URLs and MCP payload objects', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'dashboard-server',
        runtime_context: 'user',
        route: '/runs/r_secret?token=abc',
        mcpPayload: { tool: 'read_secret', payload: { token: 'abc' } },
      },
    })

    const serializedProperties = JSON.stringify(event.properties)
    expect(serializedProperties).not.toContain('/runs/r_secret?token=abc')
    expect(serializedProperties).not.toContain('read_secret')
    expect(serializedProperties).not.toContain('token')
  })

  it('drops raw agent strings while allowing normalized agent products', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'cli',
        runtime_context: 'agent',
        raw_agent: 'AGENT=goose',
        agent_product: 'goose',
      },
    })

    expect(event.properties.agent_product).toBe('goose')
    expect(event.properties).not.toHaveProperty('raw_agent')
    expect(JSON.stringify(event.properties)).not.toContain('AGENT=goose')
  })

  it('rejects run event names that belong to later phases', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.run.completed',
      properties: {
        surface: 'core',
        runtime_context: 'user',
      },
    })).toThrow()
  })

  it('continues to allow canonical test and suite ids in negative cases', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.analytics.test_event',
      properties: {
        surface: 'core',
        runtime_context: 'user',
        test_id: testId,
        suite_id: suiteId,
        route: '/runs/r_secret?token=abc',
      },
    })

    expect(event.properties.test_id).toBe(testId)
    expect(event.properties.suite_id).toBe(suiteId)
    expect(JSON.stringify(event.properties)).not.toContain('/runs/r_secret?token=abc')
  })

  it('accepts the exact minimal dashboard event set and rejects route/page events', () => {
    expect(buildAnalyticsEvent({
      name: 'agent-qa.dashboard.opened',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        agent_qa_version: '0.1.0',
      },
    }).properties).toMatchObject({
      surface: 'dashboard-ui',
      runtime_context: 'user',
      agent_qa_version: '0.1.0',
      $process_person_profile: false,
    })

    expect(buildAnalyticsEvent({
      name: 'agent-qa.dashboard.live_mode.started',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        platform: 'android',
        entity_type: 'test',
      },
    }).properties).toMatchObject({
      surface: 'dashboard-ui',
      runtime_context: 'user',
      platform: 'android',
      entity_type: 'test',
      $process_person_profile: false,
    })

    expect(buildAnalyticsEvent({
      name: 'agent-qa.dashboard.entity.created',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        entity_type: 'hook',
        outcome: 'created',
      },
    }).properties).toMatchObject({
      surface: 'dashboard-ui',
      runtime_context: 'user',
      entity_type: 'hook',
      outcome: 'created',
      $process_person_profile: false,
    })

    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.dashboard.route.viewed',
      properties: { surface: 'dashboard-ui' },
    })).toThrow()
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.dashboard.page.accessed',
      properties: { surface: 'dashboard-ui' },
    })).toThrow()
  })

  it('strips forbidden dashboard payload fields and sentinel content', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.dashboard.opened',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        run_id: runId,
        test_id: testId,
        suite_id: suiteId,
        hook_id: 'h_phase244-secret',
        entity_id: 'e_phase244-secret',
        entity_name: 'phase244-entity-name',
        route: 'phase244-route-secret',
        path: '/phase244-route-secret',
        url: 'https://phase244-secret.example',
        query: '?token=phase244-route-secret',
        target_name: 'phase244-entity-name',
        target_url: 'https://phase244-secret.example',
        yaml: 'phase244-yaml-secret',
        source: 'phase244-yaml-secret',
        hook_source: 'phase244-yaml-secret',
        prompt: 'phase244-prompt-secret',
        logs: 'phase244-log-secret',
        screenshot: 'phase244-screenshot-secret',
        dom_snapshot: 'phase244-dom-secret',
        a11y_snapshot: 'phase244-a11y-secret',
        config_payload: 'phase244-config-secret',
        credentials: 'phase244-credentials-secret',
        error: 'phase244-error-secret',
        validation_errors: ['phase244-validation-secret'],
      },
    })

    for (const field of [
      'run_id',
      'test_id',
      'suite_id',
      'hook_id',
      'entity_id',
      'entity_name',
      'route',
      'path',
      'url',
      'query',
      'target_name',
      'target_url',
      'yaml',
      'source',
      'hook_source',
      'prompt',
      'logs',
      'screenshot',
      'dom_snapshot',
      'a11y_snapshot',
      'config_payload',
      'credentials',
      'error',
      'validation_errors',
    ]) {
      expect(event.properties).not.toHaveProperty(field)
    }

    const serializedProperties = JSON.stringify(event.properties)
    expect(serializedProperties).not.toContain('phase244-route-secret')
    expect(serializedProperties).not.toContain('phase244-entity-name')
    expect(serializedProperties).not.toContain('https://phase244-secret.example')
    expect(serializedProperties).not.toContain('phase244-yaml-secret')
    expect(serializedProperties).not.toContain('phase244-prompt-secret')
  })

  it('rejects invalid dashboard entity and outcome enum values', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.dashboard.live_mode.started',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        platform: 'android',
        entity_type: 'hook',
      },
    })).toThrow()

    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.dashboard.entity.created',
      properties: {
        surface: 'dashboard-ui',
        runtime_context: 'user',
        entity_type: 'test',
        outcome: 'updated',
      },
    })).toThrow()
  })

  it('builds MCP lifecycle and tool invocation events with only approved metadata', () => {
    const lifecycle = buildAnalyticsEvent({
      name: 'agent-qa.mcp.server.lifecycle',
      properties: {
        surface: 'mcp',
        runtime_context: 'agent',
        mcp_server_state: 'started',
        mcp_transport: 'http',
        mcp_host_kind: 'loopback',
        mcp_port_kind: 'default',
        mcp_path_kind: 'default',
      },
    })

    expect(lifecycle.properties).toMatchObject({
      surface: 'mcp',
      runtime_context: 'agent',
      mcp_server_state: 'started',
      mcp_transport: 'http',
      mcp_host_kind: 'loopback',
      mcp_port_kind: 'default',
      mcp_path_kind: 'default',
      $process_person_profile: false,
    })

    const disabled = buildAnalyticsEvent({
      name: 'agent-qa.mcp.server.lifecycle',
      properties: {
        surface: 'dashboard-server',
        runtime_context: 'user',
        mcp_server_state: 'disabled',
        mcp_transport: 'http',
      },
    })

    expect(disabled.properties).toMatchObject({
      surface: 'dashboard-server',
      runtime_context: 'user',
      mcp_server_state: 'disabled',
      mcp_transport: 'http',
      $process_person_profile: false,
    })

    const invoked = buildAnalyticsEvent({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        runtime_context: 'agent',
        tool_name: 'agent_qa_get_run',
        mcp_tool_category: 'run',
        mcp_tool_status: 'success',
        duration_ms: 12,
        run_id: runId,
      },
    })

    expect(invoked.properties).toMatchObject({
      surface: 'mcp',
      runtime_context: 'agent',
      tool_name: 'agent_qa_get_run',
      mcp_tool_category: 'run',
      mcp_tool_status: 'success',
      duration_ms: 12,
      run_id: runId,
      $process_person_profile: false,
    })
  })

  it('rejects invalid MCP lifecycle, transport, tool status, and error category values', () => {
    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.mcp.server.lifecycle',
      properties: {
        surface: 'mcp',
        mcp_server_state: 'enabled',
        mcp_transport: 'http',
      },
    })).toThrow()

    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.mcp.server.lifecycle',
      properties: {
        surface: 'mcp',
        mcp_server_state: 'started',
        mcp_transport: 'remote',
      },
    })).toThrow()

    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        tool_name: 'agent_qa_get_run',
        mcp_tool_category: 'run',
        mcp_tool_status: 'ok',
      },
    })).toThrow()

    expect(() => buildAnalyticsEvent({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        tool_name: 'agent_qa_get_run',
        mcp_tool_category: 'run',
        mcp_tool_status: 'error',
        mcp_error_category: 'http_500',
      },
    })).toThrow()
  })

  it('strips forbidden MCP payload, endpoint, file, memory, config, and error fields', () => {
    const event = buildAnalyticsEvent({
      name: 'agent-qa.mcp.tool.invoked',
      properties: {
        surface: 'mcp',
        runtime_context: 'agent',
        tool_name: 'agent_qa_create_test',
        mcp_tool_category: 'authoring',
        mcp_tool_status: 'error',
        mcp_error_category: 'validation',
        duration_ms: 1,
        args: 'phase245-prompt-secret',
        arguments: { prompt: 'phase245-prompt-secret' },
        input: 'phase245-yaml-secret',
        output: 'phase245-artifact-secret',
        response: 'phase245-log-secret',
        body: 'phase245-memory-secret',
        payload: 'phase245-config-secret',
        yaml: 'phase245-yaml-secret',
        source: 'phase245-yaml-secret',
        artifact: 'phase245-artifact-secret',
        logs: 'phase245-log-secret',
        hook_payload: 'phase245-hook-secret',
        memory_body: 'phase245-memory-secret',
        config_payload: 'phase245-config-secret',
        endpointUrl: 'https://phase245-secret.example',
        dashboardUrl: 'https://phase245-secret.example',
        url: 'https://phase245-secret.example',
        path: '/Users/phase245/private.yaml',
        filePath: '/Users/phase245/private.yaml',
        remoteUrl: 'https://phase245-secret.example',
        error: 'phase245-error-secret',
        error_message: 'phase245-error-secret',
        status_text: 'phase245-error-secret',
        validation_issues: ['phase245-error-secret'],
      },
    })

    for (const field of [
      'args',
      'arguments',
      'input',
      'output',
      'response',
      'body',
      'payload',
      'yaml',
      'source',
      'artifact',
      'logs',
      'hook_payload',
      'memory_body',
      'config_payload',
      'endpointUrl',
      'dashboardUrl',
      'url',
      'path',
      'filePath',
      'remoteUrl',
      'error',
      'error_message',
      'status_text',
      'validation_issues',
    ]) {
      expect(event.properties).not.toHaveProperty(field)
    }

    const serializedProperties = JSON.stringify(event.properties)
    expect(serializedProperties).not.toContain('phase245-prompt-secret')
    expect(serializedProperties).not.toContain('phase245-yaml-secret')
    expect(serializedProperties).not.toContain('phase245-artifact-secret')
    expect(serializedProperties).not.toContain('phase245-log-secret')
    expect(serializedProperties).not.toContain('phase245-hook-secret')
    expect(serializedProperties).not.toContain('phase245-memory-secret')
    expect(serializedProperties).not.toContain('phase245-config-secret')
    expect(serializedProperties).not.toContain('phase245-error-secret')
    expect(serializedProperties).not.toContain('https://phase245-secret.example')
    expect(serializedProperties).not.toContain('/Users/phase245/private.yaml')
  })

  it('strips phase 246 sensitive sentinels from every v33 event family', () => {
    const forbiddenProperties = {
      prompt: 'phase246-sensitive-prompt',
      step_text: 'phase246-sensitive-step-text',
      target_url: 'https://phase246-sensitive.example',
      file_path: '/Users/phase246/private.yaml',
      screenshot_path: 'phase246-sensitive-screenshot.png',
      video_path: 'phase246-sensitive-video.webm',
      dom_snapshot: '<phase246-sensitive-dom />',
      accessibility_tree: 'phase246-sensitive-a11y',
      console_logs: ['phase246-sensitive-console'],
      network_logs: ['phase246-sensitive-network'],
      memory_body: 'phase246-sensitive-memory',
      config_payload: { secret: 'phase246-sensitive-config' },
      credential: 'phase246-sensitive-credential',
      env_value: 'phase246-sensitive-env',
      error_message: 'phase246-sensitive-error',
      yaml_source: 'phase246-sensitive-yaml',
      hook_output: 'phase246-sensitive-hook',
      yaml: 'phase246-sensitive-yaml',
      hook_payload: 'phase246-sensitive-hook',
      route: '/phase246-sensitive-route?token=secret',
      mcpPayload: { payload: 'phase246-sensitive-mcp-payload' },
    }
    const eventInputs = [
      {
        name: 'agent-qa.analytics.initialized',
        properties: {
          surface: 'core',
          runtime_context: 'user',
          transport: 'posthog',
          posthog_key_present: true,
        },
      },
      {
        name: 'agent-qa.analytics.test_event',
        properties: {
          surface: 'core',
          runtime_context: 'user',
        },
      },
      {
        name: 'agent-qa.test_run.completed',
        properties: {
          surface: 'cli',
          runtime_context: 'user',
          run_id: runId,
          test_id: testId,
          status: 'passed',
        },
      },
      {
        name: 'agent-qa.suite_run.completed',
        properties: {
          surface: 'cli',
          runtime_context: 'user',
          run_id: runId,
          suite_id: suiteId,
          status: 'failed',
        },
      },
      {
        name: 'agent-qa.dashboard.opened',
        properties: {
          surface: 'dashboard-ui',
          runtime_context: 'user',
        },
      },
      {
        name: 'agent-qa.dashboard.live_mode.started',
        properties: {
          surface: 'dashboard-ui',
          runtime_context: 'user',
          platform: 'web',
          entity_type: 'test',
        },
      },
      {
        name: 'agent-qa.dashboard.entity.created',
        properties: {
          surface: 'dashboard-ui',
          runtime_context: 'user',
          entity_type: 'test',
          outcome: 'created',
        },
      },
      {
        name: 'agent-qa.mcp.server.lifecycle',
        properties: {
          surface: 'mcp',
          runtime_context: 'agent',
          mcp_server_state: 'started',
          mcp_transport: 'stdio',
        },
      },
      {
        name: 'agent-qa.mcp.tool.invoked',
        properties: {
          surface: 'mcp',
          runtime_context: 'agent',
          tool_name: 'agent_qa_discover',
          mcp_tool_category: 'discovery',
          mcp_tool_status: 'success',
          duration_ms: 1,
          mcp_transport: 'stdio',
        },
      },
    ]

    for (const input of eventInputs) {
      const event = buildAnalyticsEvent({
        name: input.name,
        properties: {
          ...input.properties,
          ...forbiddenProperties,
        },
      })
      const serializedEvent = JSON.stringify(event)

      for (const field of Object.keys(forbiddenProperties)) {
        expect(event.properties).not.toHaveProperty(field)
      }

      expect(serializedEvent).not.toContain('phase246-sensitive')
      expect(serializedEvent).not.toContain('https://phase246-sensitive.example')
      expect(serializedEvent).not.toContain('/Users/phase246/private.yaml')
    }
  })
})
