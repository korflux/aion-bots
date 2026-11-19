'use client';

// Tela de erro do LAYOUT RAIZ (design: Login, TOTP, não encontrada e erro; F11 passo 5, A18): quando o próprio `layout.tsx` falha, o Next troca a raiz inteira por este
// arquivo, que por isso define o próprio `<html>` e `<body>` e importa o que a tela precisa (os tokens e a fonte de texto; a Fredoka não é usada aqui). A composição é a
// de `error.tsx` (`AppError`: Faísca em erro, "Algo deu errado", "Tentar novamente" e "Ir para o Início"), sem depender do shell, da sessão nem do que o layout
// raiz monta. Sem `metadata` em componente de cliente: o título e o viewport entram como elementos do documento (o React os leva ao `<head>`). Como o erro real fica no
// log do servidor, nada técnico aparece.
import './globals.css';
import '@fontsource-variable/inter';
import AppError from './error';

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="pt-BR">
      <body>
        <title>Algo deu errado · Aion</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <AppError error={error} retry={retry} />
      </body>
    </html>
  );
}
