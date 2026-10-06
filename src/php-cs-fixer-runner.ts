export const phpCsFixerRunner = String.raw`
require $argv[1];
$result = ['version' => PhpCsFixer\Console\Application::VERSION, 'files' => [], 'fixers' => [], 'events' => [], 'changes' => [], 'errors' => [], 'blocked' => null, 'dryRun' => true, 'usingCache' => false, 'exitCode' => 2];
try {
    if ($result['version'] !== '3.95.27') throw new RuntimeException('unsupported-version');
    if (version_compare(PHP_VERSION, PhpCsFixer\ConfigInterface::PHP_VERSION_SYNTAX_SUPPORTED.'.99', '>')) throw new RuntimeException('unsupported-php-version');
    foreach (['filter','hash','json','tokenizer'] as $extension) if (!extension_loaded($extension)) throw new RuntimeException('missing-runtime-extension');
    $resolver = new PhpCsFixer\Console\ConfigurationResolver(new PhpCsFixer\Config(), [
        'config' => $argv[2], 'path' => array_slice($argv, 3), 'path-mode' => 'intersection',
        'dry-run' => true, 'using-cache' => 'no', 'allow-risky' => 'no',
        'allow-unsupported-php-version' => 'no', 'sequential' => true,
        'stop-on-violation' => false, 'diff' => true, 'format' => 'json', 'show-progress' => 'none',
    ], getcwd(), new PhpCsFixer\ToolInfo());
    $files = iterator_to_array($resolver->getFinder(), false);
    $fixers = $resolver->getFixers();
    $result['fixers'] = array_map(static fn ($fixer) => $fixer->getName(), $fixers);
    if ($fixers === []) throw new RuntimeException('no-active-rules');
    if ($resolver->getUsingCache() || !$resolver->isDryRun()) throw new RuntimeException('unsafe-resolver-settings');
    $cache = $resolver->getCacheManager();
    if (!$cache instanceof PhpCsFixer\Cache\NullCacheManager) throw new RuntimeException('unexpected-cache-manager');
    $errors = new PhpCsFixer\Error\ErrorsManager();
    $dispatcher = new Symfony\Component\EventDispatcher\EventDispatcher();
    $current = null;
    $dispatcher->addListener(PhpCsFixer\Runner\Event\FileProcessed::NAME, static function ($event) use (&$result, &$current) {
        $result['events'][] = ['file' => $current, 'status' => $event->getStatus()];
    });
    foreach ($files as $file) {
        $current = $file->getRealPath();
        if ($current === false || $file->isLink() || !$file->isFile()) throw new RuntimeException('unsupported-finder-entry');
        $result['files'][] = $current;
        // One selected native file per sequential runner makes the event's
        // otherwise address-free status unambiguous. Resolve config only once.
        $runner = new PhpCsFixer\Runner\Runner(new ArrayIterator([$file]), $fixers,
            $resolver->getDiffer(), $dispatcher, $errors, $resolver->getLinter(), true,
            $cache, $resolver->getDirectory(), false,
            new PhpCsFixer\Runner\Parallel\ParallelConfig(1), null,
            $resolver->getConfigFile(), $resolver->getRuleCustomisationPolicy());
        foreach ($runner->fix() as $name => $change) {
            $result['changes'][] = ['file' => $current, 'fixers' => $change['appliedFixers'], 'diff' => $change['diff']];
        }
    }
    foreach ([$errors->getInvalidErrors(), $errors->getExceptionErrors(), $errors->getLintErrors()] as $group) {
        foreach ($group as $error) $result['errors'][] = [
            'file' => $error->getFilePath(), 'type' => $error->getType(),
            'message' => $error->getSource()?->getMessage() ?? 'Native fixer error',
        ];
    }
    $result['exitCode'] = (new PhpCsFixer\Console\Command\FixCommandExitStatusCalculator())->calculate(true,
        $result['changes'] !== [], $errors->getInvalidErrors() !== [],
        $errors->getExceptionErrors() !== [], $errors->getLintErrors() !== []);
} catch (Throwable $error) {
    // Configuration/runtime failures are prerequisite evidence, never source findings.
    $result['blocked'] = $error->getMessage();
    $result['exitCode'] = 2;
}
echo json_encode($result, JSON_THROW_ON_ERROR);
exit($result['exitCode']);
`;
