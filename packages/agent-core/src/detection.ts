import type {
  DetectedStack,
  EntryPoint,
  EntryPointKind,
  FrameworkId,
  GitHubTreeNode,
  KeyFile,
  KeyFileRole,
  RepoType,
  RepoTypeResult,
  RuntimeId,
  StackCategory,
} from './types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function filePaths(tree: GitHubTreeNode[]): Set<string> {
  return new Set(tree.filter((n) => n.type === 'blob').map((n) => n.path))
}

function hasFile(paths: Set<string>, ...candidates: string[]): boolean {
  return candidates.some((p) => paths.has(p))
}

function hasPattern(tree: GitHubTreeNode[], pattern: RegExp): boolean {
  return tree.some((n) => n.type === 'blob' && pattern.test(n.path))
}

function getContent(
  fileContents: Map<string, string>,
  ...candidates: string[]
): string | null {
  for (const p of candidates) {
    const c = fileContents.get(p)
    if (c !== undefined) return c
  }
  return null
}

// Safe JSON parse — returns null on failure
function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function depsOf(pkg: Record<string, unknown>): Set<string> {
  const deps = new Set<string>()
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const block = pkg[key]
    if (block !== null && typeof block === 'object' && !Array.isArray(block)) {
      for (const name of Object.keys(block as Record<string, unknown>)) {
        deps.add(name)
      }
    }
  }
  return deps
}

function scriptsOf(pkg: Record<string, unknown>): Record<string, string> {
  const scripts = pkg['scripts']
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof v === 'string') result[k] = v
    }
    return result
  }
  return {}
}

// ─── detectStack ─────────────────────────────────────────────────────────────

export function detectStack(
  tree: GitHubTreeNode[],
  fileContents: Map<string, string>,
): DetectedStack {
  const paths = filePaths(tree)
  let runtime: RuntimeId = 'unknown'
  let framework: FrameworkId = 'unknown'
  let category: StackCategory = 'unknown'
  let packageManager: DetectedStack['packageManager'] = 'unknown'
  let language: DetectedStack['language'] = 'unknown'
  let hasTests = false
  let hasDocker = false
  let hasCi = false
  const additionalLibraries: string[] = []
  let confidence = 0

  // ── Docker / CI (universal) ─────────────────────────────────────────────
  hasDocker =
    hasFile(paths, 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml') ||
    hasPattern(tree, /^docker-compose(\.[^/]+)?\.ya?ml$/)

  hasCi =
    hasFile(paths, '.github/workflows', 'Jenkinsfile', '.travis.yml', '.circleci/config.yml') ||
    hasPattern(tree, /^\.github\/workflows\/.+\.ya?ml$/) ||
    hasPattern(tree, /^\.gitlab-ci\.ya?ml$/) ||
    hasFile(paths, 'bitbucket-pipelines.yml', 'azure-pipelines.yml', '.drone.yml')

  // ── Node.js ecosystem ────────────────────────────────────────────────────
  if (hasFile(paths, 'package.json')) {
    const raw = getContent(fileContents, 'package.json')
    const pkg = raw !== null ? tryParseJson(raw) : null
    const deps = pkg !== null ? depsOf(pkg) : new Set<string>()
    const scripts = pkg !== null ? scriptsOf(pkg) : {}

    // Bun
    if (hasFile(paths, 'bun.lockb', 'bun.lock')) {
      runtime = 'bun'
      packageManager = 'bun'
      confidence = Math.max(confidence, 0.85)
    }
    // Deno
    else if (hasFile(paths, 'deno.json', 'deno.jsonc', 'import_map.json')) {
      runtime = 'deno'
      packageManager = 'unknown'
      confidence = Math.max(confidence, 0.85)
    }
    // Node
    else {
      runtime = 'nodejs'
      confidence = Math.max(confidence, 0.7)
    }

    // Package manager
    if (hasFile(paths, 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
      packageManager = 'pnpm'
      confidence = Math.max(confidence, 0.9)
    } else if (hasFile(paths, 'yarn.lock')) {
      packageManager = 'yarn'
    } else if (hasFile(paths, 'package-lock.json')) {
      packageManager = 'npm'
    } else if (hasFile(paths, 'bun.lockb', 'bun.lock')) {
      packageManager = 'bun'
    }

    // Language
    language =
      hasFile(paths, 'tsconfig.json') || deps.has('typescript')
        ? 'typescript'
        : 'javascript'
    if (language === 'typescript') confidence = Math.min(1, confidence + 0.05)

    // Framework detection (highest-signal first)
    if (deps.has('next')) {
      framework = 'nextjs'
      category = 'fullstack'
      confidence = Math.min(1, confidence + 0.1)
    } else if (deps.has('nuxt') || deps.has('nuxt3') || deps.has('@nuxt/kit')) {
      framework = 'nuxt'
      category = 'fullstack'
    } else if (deps.has('@remix-run/react') || deps.has('@remix-run/node')) {
      framework = 'remix'
      category = 'fullstack'
    } else if (deps.has('astro')) {
      framework = 'astro'
      category = 'frontend'
    } else if (deps.has('@nestjs/core')) {
      framework = 'nestjs'
      category = 'backend'
    } else if (deps.has('hono')) {
      framework = 'hono'
      category = 'backend'
    } else if (deps.has('fastify')) {
      framework = 'fastify'
      category = 'backend'
    } else if (deps.has('express')) {
      framework = 'express'
      category = 'backend'
    } else if (deps.has('@sveltejs/kit') || deps.has('svelte')) {
      framework = 'svelte'
      category = 'fullstack'
    } else if (deps.has('@angular/core')) {
      framework = 'angular'
      category = 'frontend'
    } else if (deps.has('vue')) {
      framework = 'vue'
      category = 'frontend'
    } else if (deps.has('react')) {
      framework = 'react'
      category = 'frontend'
    }

    // Tests
    hasTests =
      deps.has('vitest') ||
      deps.has('jest') ||
      deps.has('mocha') ||
      deps.has('@playwright/test') ||
      deps.has('cypress') ||
      'test' in scripts ||
      hasPattern(tree, /\.(test|spec)\.(ts|tsx|js|jsx)$/)

    // Additional libraries worth surfacing
    const notableLibs: string[] = [
      'prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'mongoose',
      'zod', 'valibot', 'yup',
      'trpc', '@trpc/server',
      'graphql', '@apollo/server',
      'tailwindcss', '@tailwindcss/postcss',
      'shadcn-ui', '@radix-ui/react-slot',
      'zustand', 'jotai', 'recoil', '@reduxjs/toolkit',
      'axios', 'swr', '@tanstack/react-query',
      'stripe',
      'anthropic', '@anthropic-ai/sdk',
      'openai',
    ]
    for (const lib of notableLibs) {
      if (deps.has(lib)) additionalLibraries.push(lib)
    }

    // Monorepo
    if (hasFile(paths, 'pnpm-workspace.yaml') || hasFile(paths, 'turbo.json') || hasFile(paths, 'nx.json')) {
      category = 'monorepo'
    }
  }

  // ── Python ───────────────────────────────────────────────────────────────
  else if (
    hasFile(paths, 'requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'poetry.lock')
  ) {
    runtime = 'python'
    language = 'python'
    packageManager = 'pip'
    confidence = Math.max(confidence, 0.8)

    const reqContent = getContent(fileContents, 'requirements.txt') ?? ''
    const pyprojectContent = getContent(fileContents, 'pyproject.toml') ?? ''
    const combined = `${reqContent}\n${pyprojectContent}`.toLowerCase()

    if (combined.includes('django')) { framework = 'django'; category = 'fullstack' }
    else if (combined.includes('fastapi')) { framework = 'fastapi'; category = 'backend' }
    else if (combined.includes('flask')) { framework = 'flask'; category = 'backend' }

    hasTests =
      hasPattern(tree, /test_.*\.py$/) ||
      hasPattern(tree, /.*_test\.py$/) ||
      combined.includes('pytest') ||
      combined.includes('unittest')
  }

  // ── Go ────────────────────────────────────────────────────────────────────
  else if (hasFile(paths, 'go.mod')) {
    runtime = 'go'
    language = 'go'
    packageManager = 'go'
    confidence = Math.max(confidence, 0.9)

    const gomod = getContent(fileContents, 'go.mod') ?? ''
    if (gomod.includes('github.com/gin-gonic/gin')) { framework = 'gin'; category = 'backend' }
    else if (gomod.includes('github.com/labstack/echo')) { framework = 'echo'; category = 'backend' }

    hasTests = hasPattern(tree, /_test\.go$/)
  }

  // ── Rust ──────────────────────────────────────────────────────────────────
  else if (hasFile(paths, 'Cargo.toml')) {
    runtime = 'rust'
    language = 'rust'
    packageManager = 'cargo'
    confidence = Math.max(confidence, 0.9)

    const cargo = getContent(fileContents, 'Cargo.toml') ?? ''
    if (cargo.includes('axum')) { framework = 'axum'; category = 'backend' }

    hasTests = hasPattern(tree, /\.rs$/)
  }

  // ── Java / JVM ────────────────────────────────────────────────────────────
  else if (hasFile(paths, 'pom.xml', 'build.gradle', 'build.gradle.kts')) {
    runtime = 'java'
    language = 'java'
    packageManager = hasFile(paths, 'pom.xml') ? 'maven' : 'gradle'
    confidence = Math.max(confidence, 0.85)

    const pom = getContent(fileContents, 'pom.xml') ?? ''
    if (pom.includes('spring-boot') || pom.includes('spring-framework')) {
      framework = 'spring'
      category = 'backend'
    }

    hasTests = hasPattern(tree, /Test\.java$/) || hasPattern(tree, /Spec\.java$/)
  }

  // ── Ruby ──────────────────────────────────────────────────────────────────
  else if (hasFile(paths, 'Gemfile', 'Gemfile.lock')) {
    runtime = 'ruby'
    language = 'unknown'
    packageManager = 'unknown'
    confidence = Math.max(confidence, 0.8)

    const gemfile = getContent(fileContents, 'Gemfile') ?? ''
    if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) {
      category = 'fullstack'
    }

    hasTests = hasPattern(tree, /_spec\.rb$/) || hasPattern(tree, /_test\.rb$/)
  }

  // ── PHP ───────────────────────────────────────────────────────────────────
  else if (hasFile(paths, 'composer.json')) {
    runtime = 'php'
    language = 'unknown'
    packageManager = 'unknown'
    confidence = Math.max(confidence, 0.8)

    hasTests = hasPattern(tree, /Test\.php$/)
  }

  return {
    runtime,
    framework,
    category,
    packageManager,
    language,
    hasTests,
    hasDocker,
    hasCi,
    additionalLibraries,
    confidence,
  }
}

// ─── identifyEntryPoints ──────────────────────────────────────────────────────

export function identifyEntryPoints(
  tree: GitHubTreeNode[],
  stack: DetectedStack,
): EntryPoint[] {
  const paths = filePaths(tree)
  const results: EntryPoint[] = []

  function add(
    path: string,
    kind: EntryPointKind,
    reason: string,
    priority: number,
  ): void {
    if (paths.has(path)) {
      results.push({ path, kind, reason, priority })
    }
  }

  switch (stack.framework) {
    case 'nextjs':
      add('app/page.tsx', 'app', 'Next.js App Router root page', 10)
      add('app/page.jsx', 'app', 'Next.js App Router root page', 10)
      add('app/layout.tsx', 'config', 'Next.js root layout', 9)
      add('app/layout.jsx', 'config', 'Next.js root layout', 9)
      add('pages/index.tsx', 'app', 'Next.js Pages Router index', 9)
      add('pages/index.jsx', 'app', 'Next.js Pages Router index', 9)
      add('pages/_app.tsx', 'config', 'Next.js custom App component', 8)
      add('pages/_app.jsx', 'config', 'Next.js custom App component', 8)
      add('next.config.ts', 'config', 'Next.js configuration', 7)
      add('next.config.js', 'config', 'Next.js configuration', 7)
      add('next.config.mjs', 'config', 'Next.js configuration', 7)
      break

    case 'react':
      add('src/main.tsx', 'main', 'React application entry point', 10)
      add('src/main.jsx', 'main', 'React application entry point', 10)
      add('src/index.tsx', 'index', 'React application entry point', 10)
      add('src/index.jsx', 'index', 'React application entry point', 10)
      add('src/App.tsx', 'app', 'Root App component', 9)
      add('src/App.jsx', 'app', 'Root App component', 9)
      add('index.html', 'main', 'Vite/React HTML entry', 8)
      break

    case 'vue':
    case 'nuxt':
      add('src/main.ts', 'main', 'Vue application entry point', 10)
      add('src/main.js', 'main', 'Vue application entry point', 10)
      add('src/App.vue', 'app', 'Root Vue component', 9)
      add('nuxt.config.ts', 'config', 'Nuxt configuration', 8)
      add('nuxt.config.js', 'config', 'Nuxt configuration', 8)
      add('pages/index.vue', 'app', 'Nuxt root page', 9)
      break

    case 'svelte':
      add('src/app.html', 'main', 'SvelteKit HTML template', 10)
      add('src/routes/+page.svelte', 'app', 'SvelteKit root page', 9)
      add('src/routes/+layout.svelte', 'config', 'SvelteKit root layout', 8)
      add('svelte.config.js', 'config', 'Svelte configuration', 7)
      break

    case 'express':
    case 'fastify':
    case 'nestjs':
    case 'hono':
      add('src/index.ts', 'server', 'Server entry point', 10)
      add('src/index.js', 'server', 'Server entry point', 10)
      add('src/main.ts', 'main', 'Application entry point', 10)
      add('src/main.js', 'main', 'Application entry point', 10)
      add('src/app.ts', 'server', 'Application setup', 9)
      add('src/app.js', 'server', 'Application setup', 9)
      add('server.ts', 'server', 'Server entry point', 9)
      add('server.js', 'server', 'Server entry point', 9)
      add('index.ts', 'index', 'Package entry point', 8)
      add('index.js', 'index', 'Package entry point', 8)
      break

    case 'django':
      add('manage.py', 'cli', 'Django management command runner', 10)
      // find wsgi.py pattern
      for (const node of tree) {
        if (node.type === 'blob' && /wsgi\.py$/.test(node.path)) {
          results.push({ path: node.path, kind: 'server', reason: 'Django WSGI application', priority: 9 })
        }
        if (node.type === 'blob' && /settings\.py$/.test(node.path)) {
          results.push({ path: node.path, kind: 'config', reason: 'Django settings', priority: 8 })
        }
        if (node.type === 'blob' && /urls\.py$/.test(node.path)) {
          results.push({ path: node.path, kind: 'app', reason: 'Django URL router', priority: 8 })
        }
      }
      break

    case 'fastapi':
    case 'flask':
      add('main.py', 'main', 'Python application entry point', 10)
      add('app.py', 'server', 'Python application entry point', 10)
      add('app/main.py', 'main', 'Application main module', 9)
      add('src/main.py', 'main', 'Application main module', 9)
      break

    case 'gin':
    case 'echo':
      add('main.go', 'main', 'Go application entry point', 10)
      add('cmd/main.go', 'main', 'Go main command', 9)
      // cmd/*/main.go pattern
      for (const node of tree) {
        if (node.type === 'blob' && /^cmd\/[^/]+\/main\.go$/.test(node.path)) {
          results.push({ path: node.path, kind: 'main', reason: 'Go command entry point', priority: 9 })
        }
      }
      break

    case 'axum':
    case 'spring':
    case 'remix':
    case 'astro':
    case 'angular':
    case 'unknown':
    default:
      break
  }

  // Generic fallbacks by runtime
  if (results.length === 0) {
    switch (stack.runtime) {
      case 'nodejs':
      case 'bun':
      case 'deno':
        add('src/index.ts', 'index', 'Package entry point', 8)
        add('src/index.js', 'index', 'Package entry point', 8)
        add('index.ts', 'index', 'Package entry point', 7)
        add('index.js', 'index', 'Package entry point', 7)
        break
      case 'python':
        add('main.py', 'main', 'Python entry point', 8)
        add('app.py', 'server', 'Python application', 8)
        add('__main__.py', 'main', 'Python package main', 8)
        break
      case 'go':
        add('main.go', 'main', 'Go entry point', 8)
        break
      case 'rust':
        add('src/main.rs', 'main', 'Rust binary entry point', 10)
        add('src/lib.rs', 'index', 'Rust library crate root', 9)
        break
      case 'java':
        for (const node of tree) {
          if (node.type === 'blob' && /Application\.java$/.test(node.path)) {
            results.push({ path: node.path, kind: 'main', reason: 'Spring Boot application class', priority: 10 })
          }
        }
        break
      default:
        break
    }
  }

  return results.sort((a, b) => b.priority - a.priority)
}

// ─── identifyKeyFiles ─────────────────────────────────────────────────────────

export function identifyKeyFiles(tree: GitHubTreeNode[]): KeyFile[] {
  const results: KeyFile[] = []

  const exactRules: Array<{
    path: string
    role: KeyFileRole
    importance: KeyFile['importance']
    reason: string
  }> = [
    // Documentation
    { path: 'README.md', role: 'documentation', importance: 'critical', reason: 'Project overview and getting started guide' },
    { path: 'readme.md', role: 'documentation', importance: 'critical', reason: 'Project overview and getting started guide' },
    { path: 'CONTRIBUTING.md', role: 'documentation', importance: 'high', reason: 'Contribution guidelines' },
    { path: 'ARCHITECTURE.md', role: 'documentation', importance: 'high', reason: 'Architecture documentation' },
    { path: 'CLAUDE.md', role: 'documentation', importance: 'critical', reason: 'AI assistant context and project guide' },
    { path: 'AGENTS.md', role: 'documentation', importance: 'high', reason: 'AI agent instructions' },
    { path: 'LICENSE', role: 'documentation', importance: 'low', reason: 'License file' },
    { path: 'LICENSE.md', role: 'documentation', importance: 'low', reason: 'License file' },

    // Package manifests
    { path: 'package.json', role: 'config', importance: 'critical', reason: 'Node.js package manifest with deps and scripts' },
    { path: 'pyproject.toml', role: 'config', importance: 'critical', reason: 'Python project configuration' },
    { path: 'go.mod', role: 'config', importance: 'critical', reason: 'Go module definition' },
    { path: 'Cargo.toml', role: 'config', importance: 'critical', reason: 'Rust crate manifest' },
    { path: 'pom.xml', role: 'config', importance: 'critical', reason: 'Maven project configuration' },
    { path: 'build.gradle', role: 'config', importance: 'critical', reason: 'Gradle build configuration' },
    { path: 'Gemfile', role: 'config', importance: 'critical', reason: 'Ruby gem manifest' },
    { path: 'composer.json', role: 'config', importance: 'critical', reason: 'PHP Composer manifest' },

    // TypeScript / build config
    { path: 'tsconfig.json', role: 'config', importance: 'high', reason: 'TypeScript compiler configuration' },
    { path: 'vite.config.ts', role: 'config', importance: 'high', reason: 'Vite build configuration' },
    { path: 'vite.config.js', role: 'config', importance: 'high', reason: 'Vite build configuration' },
    { path: 'webpack.config.js', role: 'config', importance: 'high', reason: 'Webpack build configuration' },
    { path: 'rollup.config.js', role: 'config', importance: 'high', reason: 'Rollup build configuration' },

    // Framework config
    { path: 'next.config.ts', role: 'config', importance: 'high', reason: 'Next.js configuration' },
    { path: 'next.config.js', role: 'config', importance: 'high', reason: 'Next.js configuration' },
    { path: 'next.config.mjs', role: 'config', importance: 'high', reason: 'Next.js configuration' },
    { path: 'nuxt.config.ts', role: 'config', importance: 'high', reason: 'Nuxt configuration' },
    { path: 'svelte.config.js', role: 'config', importance: 'high', reason: 'SvelteKit configuration' },
    { path: 'astro.config.mjs', role: 'config', importance: 'high', reason: 'Astro configuration' },
    { path: 'remix.config.js', role: 'config', importance: 'high', reason: 'Remix configuration' },

    // Linting / formatting
    { path: 'eslint.config.mjs', role: 'config', importance: 'medium', reason: 'ESLint flat config' },
    { path: 'eslint.config.js', role: 'config', importance: 'medium', reason: 'ESLint flat config' },
    { path: '.eslintrc.js', role: 'config', importance: 'medium', reason: 'ESLint configuration' },
    { path: '.eslintrc.json', role: 'config', importance: 'medium', reason: 'ESLint configuration' },
    { path: '.prettierrc', role: 'config', importance: 'medium', reason: 'Prettier formatting config' },
    { path: 'biome.json', role: 'config', importance: 'medium', reason: 'Biome linter/formatter config' },

    // Infrastructure
    { path: 'Dockerfile', role: 'config', importance: 'high', reason: 'Docker container definition' },
    { path: 'docker-compose.yml', role: 'config', importance: 'high', reason: 'Docker Compose services' },
    { path: 'docker-compose.yaml', role: 'config', importance: 'high', reason: 'Docker Compose services' },
    { path: 'vercel.json', role: 'config', importance: 'medium', reason: 'Vercel deployment config' },

    // Env
    { path: '.env.example', role: 'config', importance: 'high', reason: 'Environment variable template' },
    { path: '.env.local.example', role: 'config', importance: 'high', reason: 'Local environment template' },

    // Monorepo
    { path: 'pnpm-workspace.yaml', role: 'config', importance: 'high', reason: 'pnpm workspace definition' },
    { path: 'turbo.json', role: 'config', importance: 'high', reason: 'Turborepo pipeline configuration' },
    { path: 'nx.json', role: 'config', importance: 'high', reason: 'Nx workspace configuration' },

    // Database / schema
    { path: 'prisma/schema.prisma', role: 'schema', importance: 'critical', reason: 'Prisma database schema' },
    { path: 'schema.prisma', role: 'schema', importance: 'critical', reason: 'Prisma database schema' },
    { path: 'schema.graphql', role: 'schema', importance: 'critical', reason: 'GraphQL schema definition' },
    { path: 'src/schema.graphql', role: 'schema', importance: 'critical', reason: 'GraphQL schema definition' },
  ]

  const pathToSize = new Map(tree.filter((n) => n.type === 'blob').map((n) => [n.path, n.size ?? 0]))

  for (const rule of exactRules) {
    if (pathToSize.has(rule.path)) {
      results.push({
        path: rule.path,
        role: rule.role,
        importance: rule.importance,
        reason: rule.reason,
        size: pathToSize.get(rule.path) ?? 0,
      })
    }
  }

  // Pattern-based rules
  for (const [path, size] of pathToSize) {
    // Skip already added
    if (results.some((r) => r.path === path)) continue

    if (/\.d\.ts$/.test(path)) {
      results.push({ path, role: 'types', importance: 'medium', reason: 'TypeScript declaration file', size })
      continue
    }
    if (/\/types\.(ts|js)$/.test(path) || /\/types\/index\.(ts|js)$/.test(path)) {
      results.push({ path, role: 'types', importance: 'high', reason: 'Shared type definitions', size })
      continue
    }
    if (/migration.*\.(sql|ts|js)$/.test(path) || /\/migrations\//.test(path)) {
      results.push({ path, role: 'schema', importance: 'medium', reason: 'Database migration', size })
      continue
    }
    if (/\/router\.(ts|js|tsx|jsx)$/.test(path) || /\/routes\.(ts|js|tsx|jsx)$/.test(path)) {
      results.push({ path, role: 'router', importance: 'high', reason: 'Application router', size })
      continue
    }
  }

  // Sort: critical → high → medium → low, then cap at 12
  const order: Record<KeyFile['importance'], number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return results.sort((a, b) => order[a.importance] - order[b.importance]).slice(0, 12)
}

// ─── detectRepoType ───────────────────────────────────────────────────────────

const CODE_DIRS = new Set(['src', 'lib', 'app', 'pkg', 'cmd', 'core', 'server', 'client'])
const DOC_EXTS = new Set(['.md', '.mdx', '.rst', '.txt'])
const DATA_EXTS = new Set(['.json', '.csv', '.yaml', '.yml', '.xml', '.sql'])
const CONFIG_FILES = new Set([
  'package.json', 'tsconfig.json', 'go.mod', 'Cargo.toml', 'pyproject.toml',
  'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
  '.eslintrc.js', '.eslintrc.json', 'eslint.config.mjs', '.prettierrc', 'biome.json',
  'vite.config.ts', 'vite.config.js', 'webpack.config.js', 'rollup.config.js',
  'next.config.ts', 'next.config.js', 'next.config.mjs', 'turbo.json',
  'pnpm-workspace.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
  '.env.example', 'vercel.json', 'nx.json',
])

export function detectRepoType(
  tree: GitHubTreeNode[],
  repoName: string,
  repoDescription: string | null,
): RepoTypeResult {
  const blobs = tree.filter((n) => n.type === 'blob')
  const topDirs = new Set(
    tree
      .filter((n) => n.type === 'tree' && !n.path.includes('/'))
      .map((n) => n.path),
  )
  const totalBlobs = blobs.length

  const nameLower = repoName.toLowerCase()
  const descLower = (repoDescription ?? '').toLowerCase()

  // ── awesome-list ──────────────────────────────────────────────────────────
  if (
    nameLower.startsWith('awesome-') ||
    descLower.includes('awesome list') ||
    descLower.includes('curated list')
  ) {
    return { type: 'awesome-list' as RepoType, confidence: 0.95, reason: 'Repository name or description matches awesome-list pattern' }
  }

  // ── dotfiles ──────────────────────────────────────────────────────────────
  const dotfileCount = blobs.filter((n) => {
    const base = n.path.split('/').pop() ?? ''
    return base.startsWith('.')
  }).length

  if (nameLower.includes('dotfiles') || (totalBlobs > 0 && dotfileCount / totalBlobs > 0.5)) {
    return { type: 'dotfiles' as RepoType, confidence: 0.9, reason: 'Majority of files are dotfiles or repo name indicates dotfiles' }
  }

  const hasCodeDir = [...topDirs].some((d) => CODE_DIRS.has(d))

  // ── docs ──────────────────────────────────────────────────────────────────
  const docCount = blobs.filter((n) => {
    const ext = n.path.slice(n.path.lastIndexOf('.'))
    return DOC_EXTS.has(ext)
  }).length

  if (totalBlobs > 0 && docCount / totalBlobs > 0.7 && !hasCodeDir) {
    return { type: 'docs' as RepoType, confidence: 0.85, reason: 'Over 70% of files are documentation and no code directories found' }
  }

  // ── data ──────────────────────────────────────────────────────────────────
  const dataCount = blobs.filter((n) => {
    const ext = n.path.slice(n.path.lastIndexOf('.'))
    return DATA_EXTS.has(ext)
  }).length

  if (totalBlobs > 0 && dataCount / totalBlobs > 0.5 && !hasCodeDir) {
    return { type: 'data' as RepoType, confidence: 0.8, reason: 'Over 50% of files are data files and no code directories found' }
  }

  // ── config ────────────────────────────────────────────────────────────────
  const rootBlobs = blobs.filter((n) => !n.path.includes('/'))
  const rootConfigCount = rootBlobs.filter((n) => CONFIG_FILES.has(n.path)).length

  if (!hasCodeDir && rootBlobs.length > 0 && rootConfigCount / rootBlobs.length > 0.6) {
    return { type: 'config' as RepoType, confidence: 0.7, reason: 'Root contains mostly configuration files with no code directories' }
  }

  // ── code (default) ────────────────────────────────────────────────────────
  return { type: 'code' as RepoType, confidence: 0.75, reason: 'General code repository' }
}
