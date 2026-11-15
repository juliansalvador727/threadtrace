import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'out/', 'node_modules/', '.vscode-test/', 'media/'] },
  ...tseslint.configs.recommended,
  {
    // src/capture/ is bundled standalone for the Claude Code hook and runs
    // outside VS Code, so it must never import the vscode module.
    files: ['src/capture/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'src/capture/ is bundled standalone for the hook and must not import vscode.',
            },
          ],
        },
      ],
    },
  },
);
