'use client';

// Botões "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" (F12), compartilhados pela tela Aprovações (regra global) e pela seção
// "Aprovações do bot" do editor. Este componente só pergunta e avisa; QUEM aplica o lote e como (global ou do bot, e o que "neutro" significa em cada
// escopo) é o `onApply` de quem o usa, que chama a rota de lote do servidor.
//
// "Permitir tudo" é a única opção que tira a pergunta de todas as ações de uma vez, então só ela pede confirmação (o texto diz o alcance real,
// que quem usa informa em `allowWarning`). As outras três apertam ou devolvem a decisão e aplicam na hora. O foco inicial do modal cai em
// "Cancelar" (o primeiro botão), a opção segura. Os botões têm sempre texto: a ação é crítica demais para depender de cor ou ícone.
import { GLOBAL_RULE_VALUES, RULE_LABELS, type GlobalRule } from '@aion/shared';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';

interface BulkRuleButtonsProps {
  /** Texto visível e nome acessível do grupo (ex.: "Todas as ações"). */
  label: string;
  /** O que "Permitir tudo" muda de verdade neste escopo; aparece na confirmação. */
  allowWarning: string;
  /** Um lote em andamento: os botões ficam desabilitados até o servidor responder. */
  disabled: boolean;
  /** Chamado com a regra escolhida (para "Permitir tudo", só depois da confirmação). */
  onApply: (value: GlobalRule) => void;
}

export function BulkRuleButtons({ label, allowWarning, disabled, onApply }: BulkRuleButtonsProps) {
  const labelId = useId();
  const [confirming, setConfirming] = useState(false);

  return (
    <div role="group" aria-labelledby={labelId} className="mt-4">
      <p id={labelId} className="text-xs font-medium text-subtle">
        {label}
      </p>
      {/* Duas colunas no celular (quatro botões com texto não cabem numa linha de 375 px); linha corrida a partir de 768 px. */}
      <div className="mt-2 grid grid-cols-2 gap-2 md:flex md:flex-wrap">
        {GLOBAL_RULE_VALUES.map((value) => (
          <Button
            key={value}
            variant="secondary"
            size="sm"
            className="max-md:h-10"
            disabled={disabled}
            onClick={() => (value === 'allow' ? setConfirming(true) : onApply(value))}
          >
            {RULE_LABELS[value]} tudo
          </Button>
        ))}
      </div>

      <Modal open={confirming} onOpenChange={setConfirming}>
        <ModalContent title="Permitir tudo?" description={allowWarning}>
          <ModalActions>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              className="border border-danger/40"
              onClick={() => {
                setConfirming(false);
                onApply('allow');
              }}
            >
              Permitir tudo
            </Button>
          </ModalActions>
        </ModalContent>
      </Modal>
    </div>
  );
}
