import { z } from 'zod'
import { CodeIntelligenceService } from '../../codeintel/CodeIntelligence.js'
import { checkReadPath } from '../../policy/pathPolicy.js'
import { defineTool, type ToolContext } from '../Tool.js'

const shared = {
  maxResultChars: 80_000,
  readOnly: () => true,
  concurrency: () => 'shared' as const,
  interruptBehavior: () => 'cancel' as const,
  resources: () => [{ resource: 'workspace:source-index', mode: 'read' as const }],
  permission: async () => ({ behavior: 'allow' as const }),
  preconditions: async (_input: unknown, ctx: ToolContext) => [{
    id: 'workspace-root-present',
    passed: ctx.workspaceRoot.length > 0,
    detail: ctx.workspaceRoot,
  }],
}

const SymbolsInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(500).default(100),
}).strict()

export const CodeSymbolsTool = defineTool({
  ...shared,
  name: 'CodeSymbols',
  description:
    'Search TypeScript/JavaScript definitions by symbol name. Returns stable ' +
    'locations, kinds, signatures and export status from a shared repository index.',
  inputSchema: SymbolsInput,
  execute: async (input, ctx) => ({
    data: await service(ctx).symbols(input.query, input.limit, ctx.signal),
  }),
  postconditions: async (input, output) => [{
    id: 'result-limit-respected',
    passed: output.matches.length <= input.limit,
    detail: `${output.matches.length}/${input.limit}`,
  }],
  observe: async (_input, output) => ({
    summary: `Found ${output.matches.length} matching code symbols`,
    fields: {
      matchCount: output.matches.length,
      filesScanned: output.filesScanned,
      truncated: output.truncated,
    },
  }),
})

const ReferencesInput = z.object({
  symbol: z.string().regex(/^[A-Za-z_$][\w$]*$/),
  limit: z.number().int().positive().max(1_000).default(200),
}).strict()

export const FindReferencesTool = defineTool({
  ...shared,
  name: 'FindReferences',
  description:
    'Find identifier references across TypeScript/JavaScript source files. ' +
    'Marks definitions and returns deterministic file/line/column locations.',
  inputSchema: ReferencesInput,
  execute: async (input, ctx) => ({
    data: await service(ctx).references(input.symbol, input.limit, ctx.signal),
  }),
  postconditions: async (input, output) => [{
    id: 'result-limit-respected',
    passed: output.matches.length <= input.limit,
    detail: `${output.matches.length}/${input.limit}`,
  }],
  observe: async (input, output) => ({
    summary: `Found ${output.matches.length} references to ${input.symbol}`,
    fields: {
      symbol: input.symbol,
      referenceCount: output.matches.length,
      definitionCount: output.matches.filter(item => item.definition).length,
      filesScanned: output.filesScanned,
      truncated: output.truncated,
    },
  }),
})

const CallGraphInput = z.object({
  symbol: z.string().regex(/^[A-Za-z_$][\w$]*$/).optional(),
  maxEdges: z.number().int().positive().max(1_000).default(200),
}).strict()

export const CallGraphTool = defineTool({
  ...shared,
  name: 'CallGraph',
  description:
    'Build a lightweight TypeScript/JavaScript call graph. Optionally focus on ' +
    'one caller symbol; returns explicit nodes and directed call edges.',
  inputSchema: CallGraphInput,
  execute: async (input, ctx) => ({
    data: await service(ctx).callGraph(input.symbol, input.maxEdges, ctx.signal),
  }),
  postconditions: async (input, output) => [{
    id: 'edge-limit-respected',
    passed: output.edges.length <= input.maxEdges,
    detail: `${output.edges.length}/${input.maxEdges}`,
  }],
  observe: async (input, output) => ({
    summary: `Built call graph with ${output.nodes.length} nodes and ${output.edges.length} edges`,
    fields: {
      focus: input.symbol ?? null,
      nodeCount: output.nodes.length,
      edgeCount: output.edges.length,
      truncated: output.truncated,
    },
  }),
})

const DiagnosticsInput = z.object({
  path: z.string().min(1).optional(),
  maxIssues: z.number().int().positive().max(1_000).default(200),
}).strict()

export const CodeDiagnosticsTool = defineTool({
  ...shared,
  name: 'CodeDiagnostics',
  description:
    'Run project TypeScript diagnostics when the workspace provides TypeScript, ' +
    'or node --check for a JavaScript file. Diagnostics are returned as data.',
  inputSchema: DiagnosticsInput,
  validate: async (input, ctx) => {
    if (!input.path) return { ok: true as const }
    const check = checkReadPath(input.path, ctx.workspaceRoot)
    return check.ok
      ? { ok: true as const }
      : {
          ok: false as const,
          error: {
            code: 'SEMANTIC_VALIDATION_ERROR' as const,
            message: `path rejected: ${check.reason}`,
            retryable: false,
          },
        }
  },
  execute: async (input, ctx) => ({
    data: await service(ctx).diagnostics({
      path: input.path,
      maxIssues: input.maxIssues,
      signal: ctx.signal,
    }),
  }),
  postconditions: async (input, output) => [{
    id: 'issue-limit-respected',
    passed: output.diagnostics.length <= input.maxIssues,
    detail: `${output.diagnostics.length}/${input.maxIssues}`,
  }],
  observe: async (_input, output) => ({
    summary: output.available
      ? `${output.engine} reported ${output.diagnostics.length} diagnostics`
      : 'No compatible diagnostics engine is available in the workspace',
    fields: {
      available: output.available,
      engine: output.engine,
      diagnosticCount: output.diagnostics.length,
      exitCode: output.exitCode,
      truncated: output.truncated,
    },
  }),
})

function service(ctx: ToolContext): CodeIntelligenceService {
  return ctx.services.codeIntelligence ?? new CodeIntelligenceService(ctx.workspaceRoot)
}
