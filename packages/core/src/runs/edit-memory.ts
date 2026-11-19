// Ferramenta interna "editar memória" (F11 passos 1 e 2, spec decisões 7 e 11): o bot guarda, em texto livre, o que deve lembrar nas
// próximas execuções. Ferramenta interna: não passa por aprovação (SEC-03; a memória tem versões e desfazer).
//
// Escopo: a ferramenta escreve SOMENTE na memória do bot que a chamou. O id do bot vem do contexto da execução, e o schema
// estrito recusa qualquer outro argumento (`scope`, `botId`...), então não há como o modelo apontar para a memória global nem para
// a de outro bot. A global só o dono altera, pelas telas.
//
// Tamanho (decisão 11): acima de 8.000 caracteres a edição é recusada com orientação para reorganizar (`MEMORY_TOO_LARGE` no envelope de falha), e toda
// edição bem-sucedida devolve o tamanho atual e o limite, para o bot se antecipar. O cartão "Memória atualizada" é gravado junto da versão.
//
// Repetição (phase 15, A19): o mesmo `append` repetido na mesma execução, depois de uma queda do worker ou de nova tentativa do modelo, não acrescenta o trecho de novo
// (`MemoryService.editAsBot` devolve `repeated`, e o resultado diz que o trecho já está lá).
import { MEMORY_MAX_CHARS, MEMORY_WARN_CHARS, memoryContentInputSchema } from '@aion/shared';
import { z } from 'zod';
import { MemoryService } from '../memory/service';
import { ToolFailure, defineTool, toolFailure, type ToolOutcome } from './tools';

export const EDIT_MEMORY_TOOL = 'edit_memory';

const limitText = MEMORY_MAX_CHARS.toLocaleString('pt-BR');

export const editMemoryTool = defineTool({
  definition: {
    name: EDIT_MEMORY_TOOL,
    // As regras de memória que antes ficavam no "Funcionamento do Aion" vivem aqui (Suposição 16 da phase 3): só chegam ao modelo com a ferramenta. O que NÃO gravar sobre si mesmo (o que consegue ou
    // não fazer, as ferramentas, apps e contas que tem, conclusões tiradas de um pedido) mora SÓ aqui: a versão anterior convidava a gravar "uma limitação permanente e CONFIRMADA do que você consegue
    // fazer", e o bot do caso `acao-impossivel` do banco de testes gravava "sem ferramenta de compra de passagens..." em 3 de 25 execuções (phase 15, passo 16). A linha de memória do sistema
    // (`context.ts`) trata de segredos e de falhas de ferramenta, outra regra, e não se repete aqui. A frase seguinte da descrição (fatos do dono sobre as contas e os apps DELE podem ser gravados) existe
    // para a proibição não ser lida como "não grave nada sobre contas": ela vale só para o que o bot consegue fazer. ponytail: essa frase não foi medida com o modelo real (sem orçamento de provedor, decisão
    // do dono); medir com um caso em que o dono informa qual conta é a de trabalho e pede para lembrar, e conferir que a nota entra.
    description:
      'Edita a SUA memória: notas que você relê no início de toda execução (seção "Memória do agente"; se não aparece, está vazia) com ' +
      'preferências do dono, fatos e decisões que devem durar. Chame nesta mesma execução e ANTES de responder quando o dono pedir para lembrar ' +
      'ou anotar algo e quando você aprender algo do dono que deva durar. Não grave o que você consegue ou não consegue fazer, quais ferramentas, ' +
      'apps ou contas você tem, nem conclusões sobre o que é possível tiradas de um pedido: você vê suas ferramentas a cada execução, e uma nota ' +
      'velha sobre isso viraria falsa e te faria recusar o que passou a ser possível. Fatos do dono sobre as contas e os apps dele ("meu Gmail ' +
      'de trabalho é a conta Profissional") podem ser gravados: a proibição é só sobre o que você consegue fazer. Só diga que anotou depois de a ferramenta ' +
      'confirmar "Memória atualizada": afirmar sem chamá-la é erro grave, pois na próxima execução você não vai lembrar. Leia a memória exibida ' +
      `para não repetir o que já está nela. Limite de ${limitText} caracteres. "append" entra no fim, em nova linha; "replace" troca a memória ` +
      'inteira (use para reorganizar ou encurtar). Sem segredos nem senhas. As Regras Globais só o dono altera.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['append', 'replace'], description: 'append acrescenta ao fim; replace troca a memória inteira.' },
        content: { type: 'string', description: 'Texto (Markdown) a acrescentar ou a nova memória inteira.' },
      },
      required: ['operation', 'content'],
      additionalProperties: false,
    },
  },
  botOnly: true,
  argsSchema: z.strictObject({ operation: z.enum(['append', 'replace']), content: memoryContentInputSchema.min(1) }),
  label: ({ operation }) => (operation === 'append' ? 'Anotou na memória' : 'Reescreveu a memória'),

  async execute({ operation, content }, { pool, botId, conversationId, runId }): Promise<ToolOutcome> {
    // Rede de segurança: o motor não oferece esta ferramenta numa sessão do chat geral (sem bot não há memória própria).
    if (botId === null) throw new ToolFailure('Esta conversa não tem memória própria.');
    const result = await new MemoryService({ pool }).editAsBot(botId, { operation, content }, { conversationId, runId });
    if (result.status === 'too_large') {
      throw toolFailure(
        'MEMORY_TOO_LARGE',
        `A edição deixaria a memória com ${result.size.toLocaleString('pt-BR')} caracteres, acima do limite de ${limitText}. ` +
          'Nada foi alterado. Reorganize: use "replace" com um texto mais curto que mantenha só o que importa.',
      );
    }
    const usage = `Tamanho: ${result.size.toLocaleString('pt-BR')} de ${limitText} caracteres.`;
    // Repetição do append (queda do worker ou nova tentativa): o trecho já está no fim, e dizer isso evita o bot anotar de novo ou concluir que falhou.
    if (result.status === 'repeated') return { result: `Esse trecho já está na memória (anotado nesta execução, versão ${result.version}); nada foi acrescentado. ${usage}` };
    if (result.status === 'unchanged') return { result: `A memória já era exatamente esse texto; nada foi alterado. ${usage}` };
    const nearLimit = result.size > MEMORY_WARN_CHARS ? ' A memória está perto do limite: na próxima edição, resuma e reorganize.' : '';
    return { result: `Memória atualizada (versão ${result.version}). ${usage}${nearLimit}` };
  },
});
