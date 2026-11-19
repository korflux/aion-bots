import { contextCheckpointsMigration } from './0036_context_checkpoints';
import { contextMaintenanceMigration } from './0037_context_maintenance';
import { summaryOutcomeMigration } from './0038_summary_outcome';
import { usageEstimateMigration } from './0039_usage_estimate';
import { contextDefault64kMigration } from './0040_context_default_64k';
import { summaryModelMigration } from './0041_summary_model';
import { summaryRefusalMigration } from './0042_summary_refusal';
import { contextWindow256kMigration } from './0043_context_window_256k';
import { runRequestDataMigration } from './0044_run_request_data';
import { modelCallReasoningMigration } from './0045_model_call_reasoning';
import { contextWindow512kMigration } from './0046_context_window_512k';
import { coldMaintenanceMigration } from './0047_cold_maintenance';
import { coldCompactionMigration } from './0048_cold_compaction';
import { cacheWriteTokensMigration } from './0049_cache_write_tokens';
import { connectorAccountsMigration } from './0050_connector_accounts';
import { docsMigration } from './0051_docs';
import { requestBlockHashesMigration } from './0052_request_block_hashes';
import { pushDeliveryMigration } from './0053_push_delivery';
import { pushContentMigration } from './0054_push_content';
import { providerModelIdsMigration } from './0055_provider_model_ids';
import { tableOperationsMigration } from './0032_table_operations';
// Registro ordenado das migrations do Aion. Cada task nova acrescenta o próprio arquivo aqui, no fim.
// Regra: migration aplicada em produção nunca é editada; correções entram como migration nova.
import type { Migration } from '../migrator';
import { authFoundation } from './0001_auth_foundation';
import { totp } from './0002_totp';
import { credentials } from './0003_credentials';
import { botsMigration } from './0004_bots';
import { modelsMigration } from './0005_models';
import { conversationRunsMigration } from './0006_conversation_runs';
import { approvalsMigration } from './0007_approvals';
import { foreignKeyIndexesMigration } from './0008_foreign_key_indexes';
import { memoryVersionsMigration } from './0009_memory_versions';
import { routinesMigration } from './0010_routines';
import { pushMigration } from './0011_push';
import { generalChatMigration } from './0012_general_chat';
import { pushMutesMigration } from './0013_push_mutes';
import { generalChatSettingsMigration } from './0014_general_chat_settings';
import { appSettingsMigration } from './0015_app_settings';
import { historySearchUnaccentMigration } from './0016_history_search_unaccent';
import { webSearchSettingsMigration } from './0017_web_search_settings';
import { botMascotMigration } from './0018_bot_mascot';
import { attachmentsMigration } from './0019_attachments';
import { modelImageSupportMigration } from './0020_model_image_support';
import { presenceReadMigration } from './0021_presence_read';
import { pushRelevanceMigration } from './0022_push_relevance';
import { runLastModelMigration } from './0023_run_last_model';
import { complementsMigration } from './0024_complements';
import { conversationVersionsMigration } from './0025_conversation_versions';
import { spreadsheetAttachmentsMigration } from './0026_spreadsheet_attachments';
import { generatedAttachmentsMigration } from './0027_generated_attachments';
import { dropBotMascotMigration } from './0028_drop_bot_mascot';
import { ownerNameMigration } from './0029_owner_name';
import { botTablesMigration } from './0030_bot_tables';
import { tableViewsMigration } from './0031_table_views';

import { contextPreferencesMigration } from './0033_context_preferences';

import { botObjectivesMigration } from './0034_bot_objectives';

import { evidenceProvenanceMigration } from './0035_evidence_provenance';

export const MIGRATIONS: readonly Migration[] = [
  authFoundation,
  totp,
  credentials,
  botsMigration,
  modelsMigration,
  conversationRunsMigration,
  approvalsMigration,
  foreignKeyIndexesMigration,
  memoryVersionsMigration,
  routinesMigration,
  pushMigration,
  generalChatMigration,
  pushMutesMigration,
  generalChatSettingsMigration,
  appSettingsMigration,
  historySearchUnaccentMigration,
  webSearchSettingsMigration,
  botMascotMigration,
  attachmentsMigration,
  modelImageSupportMigration,
  presenceReadMigration,
  pushRelevanceMigration,
  runLastModelMigration,
  complementsMigration,
  conversationVersionsMigration,
  spreadsheetAttachmentsMigration,
  generatedAttachmentsMigration,
  dropBotMascotMigration,
  ownerNameMigration,
  botTablesMigration,
  tableViewsMigration,
  tableOperationsMigration,
  contextPreferencesMigration,
  botObjectivesMigration,
  evidenceProvenanceMigration,
  contextCheckpointsMigration,
  contextMaintenanceMigration,
  summaryOutcomeMigration,
  usageEstimateMigration,
  contextDefault64kMigration,
  summaryModelMigration,
  summaryRefusalMigration,
  contextWindow256kMigration,
  runRequestDataMigration,
  modelCallReasoningMigration,
  contextWindow512kMigration,
  coldMaintenanceMigration,
  coldCompactionMigration,
  cacheWriteTokensMigration,
  connectorAccountsMigration,
  docsMigration,
  requestBlockHashesMigration,
  pushDeliveryMigration,
  pushContentMigration,
  providerModelIdsMigration,
];
