# RoutineCard

Rotina na conversa (conversation/routine-card.tsx), nas duas formas da phase 18 (ver SystemCard).

- Linha: execução "Rotina “X” iniciada/concluída/interrompida" com "Ver rotina"; perdida, com CalendarX em warning, explicando que o serviço estava parado; avisos "confirmada", "recusada" e "editada", sem ações.
- Cartão de execução: "falhou", "atingiu o limite" ou "expirou", com a Faísca do bot em erro, parada, e "Ver rotina".
- Rotina criada ou alterada pelo bot (phase 10, já valendo): nome, resumo da agenda com fuso, instrução recolhível ("Mostrar mais"), próximas execuções e, na alteração, o campo "antigo → novo"; ações "Recusar" (desfaz) e "Editar" (abre o editor ligado ao cartão), depois o selo do resultado.
- Proposta e alteração antigas (anteriores à phase 10): "Confirmar" e "Editar", ou perigo "Excluir"; selo "Confirmada", ou "Desatualizada" quando a rotina mudou depois.
