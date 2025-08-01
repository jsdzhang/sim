import { TavilyIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'
import type { TavilyResponse } from '@/tools/tavily/types'

export const TavilyBlock: BlockConfig<TavilyResponse> = {
  type: 'tavily',
  name: 'Tavily',
  description: 'Search and extract information',
  longDescription:
    "Access Tavily's AI-powered search engine to find relevant information from across the web. Extract and process content from specific URLs with customizable depth options.",
  category: 'tools',
  docsLink: 'https://docs.sim.ai/tools/tavily',
  bgColor: '#0066FF',
  icon: TavilyIcon,
  subBlocks: [
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      layout: 'full',
      options: [
        { label: 'Search', id: 'tavily_search' },
        { label: 'Extract Content', id: 'tavily_extract' },
      ],
      value: () => 'tavily_search',
    },
    {
      id: 'apiKey',
      title: 'API Key',
      type: 'short-input',
      layout: 'full',
      placeholder: 'Enter your Tavily API key',
      password: true,
    },
    {
      id: 'query',
      title: 'Search Query',
      type: 'long-input',
      layout: 'full',
      placeholder: 'Enter your search query...',
      condition: { field: 'operation', value: 'tavily_search' },
    },
    {
      id: 'maxResults',
      title: 'Max Results',
      type: 'short-input',
      layout: 'full',
      placeholder: '5',
      condition: { field: 'operation', value: 'tavily_search' },
    },
    {
      id: 'urls',
      title: 'URL',
      type: 'long-input',
      layout: 'full',
      placeholder: 'Enter URL to extract content from...',
      condition: { field: 'operation', value: 'tavily_extract' },
    },
    {
      id: 'extract_depth',
      title: 'Extract Depth',
      type: 'dropdown',
      layout: 'full',
      options: [
        { label: 'basic', id: 'basic' },
        { label: 'advanced', id: 'advanced' },
      ],
      value: () => 'basic',
      condition: { field: 'operation', value: 'tavily_extract' },
    },
  ],
  tools: {
    access: ['tavily_search', 'tavily_extract'],
    config: {
      tool: (params) => {
        switch (params.operation) {
          case 'tavily_search':
            return 'tavily_search'
          case 'tavily_extract':
            return 'tavily_extract'
          default:
            return 'tavily_search'
        }
      },
    },
  },
  inputs: {
    operation: { type: 'string', required: true },
    apiKey: { type: 'string', required: true },
    query: { type: 'string', required: false },
    maxResults: { type: 'number', required: false },
    urls: { type: 'string', required: false },
    extract_depth: { type: 'string', required: false },
  },
  outputs: {
    results: 'json',
    answer: 'any',
    query: 'string',
    content: 'string',
    title: 'string',
    url: 'string',
  },
}
