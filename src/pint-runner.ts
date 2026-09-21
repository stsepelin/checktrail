export const pintRunner = String.raw`
$tool = realpath($argv[1]);
Phar::loadPhar($tool, 'repo-verifier-pint.phar');
$base = 'phar://repo-verifier-pint.phar';
$loader = require $base.'/vendor/autoload.php';
$loader->addClassMap([
    'PhpCsFixer\FixerFactory' => $base.'/overrides/FixerFactory.php',
    'PhpCsFixer\Runner\Parallel\ProcessFactory' => $base.'/overrides/Runner/Parallel/ProcessFactory.php',
]);
$app = require $base.'/bootstrap/app.php';
$input = new Symfony\Component\Console\Input\ArgvInput([
    'pint', '--test', '--format=agent', '--cache-file=/dev/null', '--no-ansi', '--no-interaction', '--', ...array_slice($argv, 2),
]);
$output = new class extends Symfony\Component\Console\Output\BufferedOutput implements Symfony\Component\Console\Output\ConsoleOutputInterface {
    private Symfony\Component\Console\Output\OutputInterface $errors;
    public function __construct() {
        parent::__construct();
        $this->errors = new Symfony\Component\Console\Output\StreamOutput(STDERR);
    }
    public function getErrorOutput(): Symfony\Component\Console\Output\OutputInterface { return $this->errors; }
    public function setErrorOutput(Symfony\Component\Console\Output\OutputInterface $error): void { $this->errors = $error; }
    public function section(): Symfony\Component\Console\Output\ConsoleSectionOutput { throw new RuntimeException('Interactive sections are unsupported'); }
};
$app->instance(Symfony\Component\Console\Input\InputInterface::class, $input);
$app->instance(Symfony\Component\Console\Output\OutputInterface::class, $output);
$kernel = $app->make(Illuminate\Contracts\Console\Kernel::class);
$kernel->bootstrap();
$evidence = ['version' => config('app.version'), 'files' => [], 'fixers' => [], 'blocked' => null];
if ($evidence['version'] !== '1.32.1') {
    $evidence['blocked'] = 'unsupported-version';
    echo json_encode($evidence, JSON_THROW_ON_ERROR);
    exit(2);
}
$app['events']->listen(Illuminate\Console\Events\CommandStarting::class, function ($event) use (&$evidence) {
    [$resolver] = App\Factories\ConfigurationResolverFactory::fromIO($event->input, $event->output);
    $evidence['files'] = array_map(fn ($file) => $file->getRealPath(), iterator_to_array($resolver->getFinder(), false));
    $fixers = $resolver->getFixers();
    $evidence['fixers'] = array_map(fn ($fixer) => $fixer->getName(), $fixers);
    if ($fixers === []) $evidence['blocked'] = 'no-active-rules';
    foreach ($fixers as $fixer) {
        if ($fixer instanceof App\Contracts\HasPrettierDependencies) $evidence['blocked'] = 'unverified-prettier-integration';
    }
    if ($evidence['blocked'] !== null) throw new RuntimeException($evidence['blocked']);
});
$status = $kernel->handle($input, $output);
$evidence['report'] = $output->fetch();
$evidence['exitCode'] = $status;
$kernel->terminate($input, $status);
echo json_encode($evidence, JSON_THROW_ON_ERROR);
exit($status);
`;
