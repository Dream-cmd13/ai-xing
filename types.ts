
export interface SIPOC {
  source?: string[]; 
  target?: string[]; 
  inputs: string[];
  standard: string; 
  outputs: string[];
  customers: string[];
  ownerRole: string;
  assistantRoles?: string[]; // New: Multiple assistant roles
}

export interface ProcessNode {
  id: string;
  label: string;
  description: string;
  type: 'start' | 'process' | 'decision' | 'end';
  sipoc: SIPOC;
  decisionDescription?: string;
  isSubProcess?: boolean;
  subProcessNodes?: ProcessNode[];
  subProcessLinks?: ProcessLink[];
  x: number;
  y: number;
  owner?: string;
  coOwner?: string;
  objective?: string;
}

export interface ProcessLink {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export type ProcessCategory = '供应链' | '需求链' | '产品研发' | '辅助体系';

export interface ProcessHistory {
  id: string;
  version: string;
  nodes: ProcessNode[];
  links: ProcessLink[];
  publishedAt: number;
  publishedBy: string;
}

export interface ProcessDefinition {
  id: string;
  departmentId?: string;
  createdBy?: string;
  name: string;
  category: ProcessCategory;
  level: 1 | 2;
  version: string;
  isActive: boolean;
  type: 'main' | 'auxiliary';
  owner: string;
  coOwner: string;
  objective: string;
  nodes: ProcessNode[];
  links: ProcessLink[];
  history: ProcessHistory[];
  updatedAt: number;
  rowVersion?: number;
}

export interface KRReview {
  comment: string;
  progress: number;
  status?: 'on-track' | 'at-risk' | 'behind';
  taskEvaluations?: Record<string, string>; // New: Map task ID -> evaluation comment
  taskScores?: Record<string, number>; // New: Map task ID -> score (1-10)
}

export interface ObjectiveReview {
  progress: number;
  krReviews: KRReview[];
  lessonsLearned?: string; // 总结经验教训
  methodology?: string; // 沉淀打法
  nextSteps?: string; // 下一步行动计划
}

export interface ReviewEntry {
  id: string;
  date: number;
  content: string;
  score: number; // 1-10
  reviewer: string;
  okrProgress?: Record<string, string>; // New: Map OKR ID -> Actual Result content
  okrDetails?: Record<string, ObjectiveReview>; // New: Detailed OKR review data
  padEntries?: PADEntry[]; // New: Monthly PAD entries
}

export interface Department {
  id: string;
  name: string;
  managerName?: string; 
  responsibilities?: string; 
  roles: string[];
  roleMembers?: Record<string, string[]>; // New: Map role name -> array of user IDs
  attributes?: string; 
  subDepartments?: Department[];
  okrs?: Record<number, Record<string, OKR[]>>; 
  reviews?: Record<string, ReviewEntry[]>; // Key: Cycle ID (e.g., '2025-W01' or '2025-M01')
  updatedAt?: number;
  rowVersion?: number;
}

export interface OKR {
  id: string;
  objective: string;
  keyResults: string[];
  alignedToIds?: string[]; 
}

export interface CompanyStrategy {
  mission: string;
  vision: string;
  customerIssues: string;
  employeeIssues: string;
  companyOKRs: Record<number, OKR[]>; 
  updatedAt?: number;
  rowVersion?: number;
}

export interface MenuPermission {
  view: boolean;
  create: boolean;
  update: boolean;
}

export interface SystemRole {
  id: string;
  name: string;
  description: string;
  permissions: Record<string, MenuPermission>;
  updatedAt?: number;
  rowVersion?: number;
}

export interface User {
  id: string;
  auth_id?: string;
  username: string;
  password?: string;
  name: string;
  role: 'Admin' | 'User';
  departmentId?: string;
  padPermissions?: string[]; 
  reviews?: Record<string, ReviewEntry[]>;
  systemRoleIds?: string[];
  customPermissions?: Record<string, MenuPermission>;
  updatedAt?: number;
  rowVersion?: number;
}

export interface TaskLog {
  id: string;
  timestamp: number;
  userId: string;
  action: string;
  details: string;
}

export interface PADEntry {
  id: string;
  departmentId?: string;
  createdBy?: string;
  title: string;
  status: 'draft' | 'submitted' | 'approved' | 'completed' | 'in-progress' | 'paused' | 'terminated';
  priority: 'low' | 'medium' | 'high';
  ownerId: string;
  participantIds?: string[];
  approverIds?: string[];
  startDate?: number;
  dueDate?: number;
  tags?: string[];
  visibility: 'public' | 'members' | 'department' | 'private';
  alignedKrId?: string; 
  targetWeeks?: string[]; // New: support multi-week tasks
  logs?: TaskLog[];
  
  // Legacy fields for backward compatibility
  plan?: string;
  action?: string;
  deliverable?: string;
  updatedAt?: number;
  rowVersion?: number;
}

export interface WeeklyPAD {
  id: string;
  weekId: string;
  ownerId: string;
  type: 'dept' | 'user';
  entries: PADEntry[];
}

export interface BusinessDefinition {
  id: string;
  name: string;
  businessFormat: string;
  customerPersona: string;
  customerNeeds: string;
  surfaceProductPower: string;
  coreProductPower: string;
  updatedAt?: number;
  rowVersion?: number;
}

export interface AIModelConfig {
  id: string;
  name: string;
  type: 'minimax' | 'deepseek' | 'gemini' | 'custom';
  apiKey: string;
  baseUrl?: string;
  modelName?: string;
}

export interface AISettings {
  selectedModelId: string;
  configs: AIModelConfig[];
  updatedAt?: number;
  rowVersion?: number;
}

export interface AppState {
  processes: ProcessDefinition[];
  departments: Department[];
  strategy: CompanyStrategy;
  businesses?: BusinessDefinition[];
  users: User[];
  tasks: PADEntry[]; // Flat tasks collection instead of weeklyPADs
  systemRoles?: SystemRole[];
  aiSettings?: AISettings;
}
